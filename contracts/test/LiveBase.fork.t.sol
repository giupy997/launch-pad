// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {SlipstreamZapRouter} from "../src/SlipstreamZapRouter.sol";

interface IUniV2PairView {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

interface IUniV2RouterSwap {
    function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        returns (uint256[] memory amounts);
}

/// End-to-end against the PRODUCTION v11 stack on Base, on a fork (no real
/// funds spent), every contract the live one: a coin is created on the live
/// pad and bought through graduation with ETH through the live zap (Aerodrome
/// → cbLTC → the curve), so the pool it seeds on the live Uniswap v2 can be
/// checked — seeded in the same transaction, the whole raise in against coins
/// at the price the curve closed at, the rest of the reserve locked in the
/// pad, the LP locked in the migrator, nothing parked —
/// and traded on the live router both ways; and a small ETH buy on the curve.
/// NOTE: targets the deployed addresses — update them after a redeploy.
/// Run with: RUN_FORK_LIVE=true forge test --match-contract LiveBase -vv
///   (FORK_RPC overrides the Base node; the default is mainnet.base.org)
contract LiveBaseForkTest is Test {
    Launchpad constant PAD = Launchpad(0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4);
    UniV2Migrator constant MIGRATOR = UniV2Migrator(payable(0x8fB7f1D18F4b2ECC79da94aBF51f95B93E07d218));
    SlipstreamZapRouter constant ZAP = SlipstreamZapRouter(payable(0x072a77dC2a770504A1DA17e2fB6814C9cFf85254));
    IERC20 constant CBLTC = IERC20(0xcb17C9Db87B595717C857a08468793f5bAb6445F);
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant UNIV2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;

    bool skipAll;
    address creator = makeAddr("creator");
    address whale = makeAddr("whale");
    address trader = makeAddr("trader");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork(vm.envOr("FORK_RPC", string("https://mainnet.base.org")));
        vm.deal(whale, 100 ether);
        vm.deal(trader, 1 ether);
    }

    /// the route the site uses: WETH → cbLTC on Aerodrome Slipstream's CL200 pool
    function _path() internal pure returns (bytes memory) {
        return abi.encodePacked(WETH, uint24(200), address(CBLTC));
    }

    function _create() internal returns (address token) {
        vm.prank(creator);
        token = PAD.createToken("Fork Test", "FORK", 0, Launchpad.TokenMetadata("", "", "", "", "", ""), address(CBLTC), false);
    }

    /// Buys the whole curve with ETH through the live zap, a few ETH at a time
    /// (Aerodrome's depth decides how much cbLTC each buys), until graduation;
    /// the pad refunds the cbLTC the last buy did not need to the whale.
    function _graduateWithEth(address token) internal {
        for (uint256 i = 0; i < 12; i++) {
            (,,,, bool graduated,,) = PAD.curves(token);
            if (graduated) return;
            vm.prank(whale);
            ZAP.zapBuy{value: 4 ether}(token, _path(), 0, 0);
        }
        (,,,, bool done,,) = PAD.curves(token);
        assertTrue(done, "48 ETH through the zap did not graduate the curve: Aerodrome's cbLTC depth?");
    }

    function _reserves(address token, address pair) internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = IUniV2PairView(pair).getReserves();
        (rToken, rQuote) = IUniV2PairView(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    function test_live_graduationSeedsTheUniswapPoolInOneTransaction() public {
        if (skipAll) return;
        assertEq(address(PAD.migrator()), address(MIGRATOR), "the live pad's migrator is the v2 adapter");
        assertEq(MIGRATOR.launchpad(), address(PAD));
        assertEq(address(MIGRATOR.router()), UNIV2_ROUTER);

        address token = _create();
        _graduateWithEth(token);
        _checkCurveClosed(token);
        address pair = _checkPoolAtTheClosingPrice(token);
        _checkLocked(token, pair);
    }

    function _checkCurveClosed(address token) internal {
        (,, uint256 realQuote, uint256 sold, bool graduated,,) = PAD.curves(token);
        assertTrue(graduated, "graduated");
        assertEq(sold, PAD.CURVE_SUPPLY(), "the whole curve sold");
        assertEq(realQuote, 0, "the reserve left for the pool in the same transaction");
        assertEq(address(PAD.graduatedVia(token)), address(MIGRATOR));
        assertEq(LaunchToken(token).balanceOf(address(PAD)), PAD.lockedAtGraduation(token), "the pad keeps only the locked share");
        assertGt(CBLTC.balanceOf(whale), 0, "the cbLTC the last buy did not need came back to the buyer");
        // the curve is closed
        vm.startPrank(whale);
        CBLTC.approve(address(PAD), type(uint256).max);
        vm.expectRevert(Launchpad.AlreadyGraduated.selector);
        PAD.buyWithQuote(token, 1e8, 0);
        vm.stopPrank();
    }

    function _checkPoolAtTheClosingPrice(address token) internal view returns (address pair) {
        pair = MIGRATOR.pairOf(token);
        assertTrue(pair != address(0), "the pool exists");
        assertEq(MIGRATOR.pairAsset(token), address(CBLTC));
        (uint256 rToken, uint256 rQuote) = _reserves(token, pair);
        assertEq(rToken + PAD.lockedAtGraduation(token), PAD.DEX_RESERVE(), "the pool and the lock share the DEX reserve");
        assertGt(PAD.lockedAtGraduation(token), 0, "the curve's virtual share stays locked");
        // the whole raise is in the pool: what a sold-out curve holds is its virtual
        // reserve grown by VIRTUAL_TOKEN / (VIRTUAL_TOKEN - CURVE_SUPPLY), less the
        // virtual part — 3.2 times the 60 cbLTC, 192 cbLTC — plus the coin's liquidity
        // pot (none: a plain createToken has no tax), to the rounding of the buys
        uint256 virtualQuote = PAD.quoteVirtualReserve(address(CBLTC));
        uint256 raise = (virtualQuote * PAD.VIRTUAL_TOKEN()) / (PAD.VIRTUAL_TOKEN() - PAD.CURVE_SUPPLY()) - virtualQuote;
        assertApproxEqAbs(rQuote, raise, 1e4, "the whole raise is in the pool");
        // the pool opens at the price the curve closed at (vEth / vToken), to a hundredth
        // of a percent: the raise against as many coins as that price says, the rest locked
        (uint256 vEth, uint256 vToken,,,,,) = PAD.curves(token);
        uint256 poolSide = rQuote * vToken;
        uint256 curveSide = vEth * rToken;
        uint256 diff = poolSide > curveSide ? poolSide - curveSide : curveSide - poolSide;
        assertLe(diff * 10_000, curveSide, "the pool opens at the closing price");
    }

    function _checkLocked(address token, address pair) internal view {
        // locked: the migrator holds every LP token but Uniswap's burned minimum
        uint256 lpTotal = IUniV2PairView(pair).totalSupply();
        assertEq(IUniV2PairView(pair).balanceOf(address(MIGRATOR)), MIGRATOR.liquidity(token));
        assertGe(MIGRATOR.liquidity(token) + 1000, lpTotal, "only the minimum liquidity is not the pad's");
        (uint256 pT, uint256 pQ) = MIGRATOR.parked(token);
        assertEq(pT + pQ, 0, "nothing parked");
        assertEq(LaunchToken(token).balanceOf(address(MIGRATOR)), 0, "the migrator keeps no coins");
        assertEq(CBLTC.balanceOf(address(MIGRATOR)), 0, "nor quote");
        assertEq(LaunchToken(token).balanceOf(address(ZAP)), 0, "the zap keeps nothing");
        assertEq(CBLTC.balanceOf(address(ZAP)), 0);
    }

    function test_live_graduatedCoinTradesOnTheLiveRouter() public {
        if (skipAll) return;
        address token = _create();
        _graduateWithEth(token);
        address pair = MIGRATOR.pairOf(token);
        (uint256 rToken0, uint256 rQuote0) = _reserves(token, pair);

        // the whale, with the cbLTC its last buy did not need, buys and sells in the pool
        uint256 spend = 1e8;
        uint256 bought = _buyInPool(token, spend);
        // what Uniswap's arithmetic says, from the reserves before
        assertEq(bought, (spend * 997 * rToken0) / (rQuote0 * 1000 + spend * 997), "the pool is a plain Uniswap v2 pair");
        uint256 back = _sellInPool(token, bought);
        assertGt(back, (spend * 99) / 100, "sold back for the spend less the two 0.3% fees and the price move");
        assertLt(back, spend);

        // the fees stayed in the pool, the LP stayed locked
        (uint256 rToken1, uint256 rQuote1) = _reserves(token, pair);
        assertGe(rToken1 * rQuote1, rToken0 * rQuote0, "the constant product does not shrink");
        assertEq(IUniV2PairView(pair).balanceOf(address(MIGRATOR)), MIGRATOR.liquidity(token), "the LP stays locked");
    }

    function _buyInPool(address token, uint256 spend) internal returns (uint256) {
        assertGe(CBLTC.balanceOf(whale), spend, "the whale has cbLTC left over");
        vm.startPrank(whale);
        CBLTC.approve(UNIV2_ROUTER, type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = address(CBLTC);
        path[1] = token;
        uint256[] memory out = IUniV2RouterSwap(UNIV2_ROUTER).swapExactTokensForTokens(spend, 0, path, whale, block.timestamp + 600);
        vm.stopPrank();
        assertGt(out[1], 0, "bought in the pool");
        return out[1];
    }

    function _sellInPool(address token, uint256 amount) internal returns (uint256) {
        vm.startPrank(whale);
        LaunchToken(token).approve(UNIV2_ROUTER, type(uint256).max);
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = address(CBLTC);
        uint256[] memory out = IUniV2RouterSwap(UNIV2_ROUTER).swapExactTokensForTokens(amount, 0, path, whale, block.timestamp + 600);
        vm.stopPrank();
        return out[1];
    }

    function test_live_smallEthBuyOnTheCurveThroughTheZap() public {
        if (skipAll) return;
        address token = _create();
        vm.prank(trader);
        ZAP.zapBuy{value: 0.01 ether}(token, _path(), 0, 0);
        assertGt(LaunchToken(token).balanceOf(trader), 0, "the trader got coins");
        (,, uint256 realQuote, uint256 sold, bool graduated,,) = PAD.curves(token);
        assertGt(realQuote, 0, "the curve holds cbLTC");
        assertGt(sold, 0);
        assertFalse(graduated);
        assertEq(LaunchToken(token).balanceOf(address(ZAP)), 0, "the zap keeps nothing");
        assertEq(CBLTC.balanceOf(address(ZAP)), 0);
        assertEq(address(ZAP).balance, 0);
        // and sells back on the curve
        vm.startPrank(trader);
        LaunchToken(token).approve(address(PAD), type(uint256).max);
        uint256 before = CBLTC.balanceOf(trader);
        PAD.sell(token, LaunchToken(token).balanceOf(trader), 0);
        vm.stopPrank();
        assertGt(CBLTC.balanceOf(trader), before, "sold back for cbLTC");
    }
}
