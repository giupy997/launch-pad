// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// The v11 pad as deployed on Liteforge, by the surface this test uses: the
/// repository's Launchpad is v12 (seven fee fields, a migration module), so
/// the pad is spoken to through its own ABI here.
interface IPadV11 {
    struct TokenMetadata {
        string logoURI;
        string website;
        string twitter;
        string telegram;
        string livestream;
        string description;
    }

    struct FeeConfig {
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 creatorBps;
        uint16 holdersBps;
        uint16 burnBps;
        uint16 liquidityBps;
    }

    function createTokenWithFees(
        string calldata name,
        string calldata symbol,
        uint256 minTokensOut,
        TokenMetadata calldata meta,
        address quoteAsset,
        FeeConfig calldata fees
    ) external payable returns (address token);
    function buy(address token, uint256 minTokensOut) external payable;
    function sell(address token, uint256 tokensIn, uint256 minEthOut) external;
    function curves(address token)
        external
        view
        returns (
            uint256 vEth,
            uint256 vToken,
            uint256 realEth,
            uint256 sold,
            bool graduated,
            address creator,
            address quoteAsset
        );
    function feeBps() external view returns (uint256);
    function treasury() external view returns (address);
    function migrator() external view returns (address);
    function graduatedVia(address token) external view returns (address);
    function burnPot(address token) external view returns (uint256);
    function liquidityPot(address token) external view returns (uint256);
    function burned(address token) external view returns (uint256);
    function lockedAtGraduation(address token) external view returns (uint256);
    function creatorFees(address recipient, address asset) external view returns (uint256);
    function cashbackOf(address token, address holder) external view returns (uint256);
    function claimCashback(address token) external;
    function claimCreatorFees(address asset) external;
    function buybackAndBurn(address token) external returns (uint256 tokensBurned);
    function DEX_RESERVE() external view returns (uint256);
    /// v11 alone: the shares of the launchpad's own fee that feed the coin's pot (the creator's and
    /// the holders'); the treasury keeps the rest. v12 pays the launchpad's fee whole to the treasury
    function creatorFeeShareBps() external view returns (uint256);
    function holderCashbackBps() external view returns (uint256);
}

interface IMigratorV2 {
    function pairOf(address token) external view returns (address);
    function liquidity(address token) external view returns (uint256);
    function router() external view returns (address);
}

interface IPairView {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function balanceOf(address) external view returns (uint256);
}

interface IRouterV2 {
    function WETH() external view returns (address);
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface ILaunchTokenView is IERC20 {
    function graduated() external view returns (bool);
}

/// A coin's whole life on the pad deployed on LitVM's Liteforge testnet (the
/// v11 rehearsal pad, quoted in native zkLTC, README Deployments), on a fork
/// of the live chain with the live contracts: created with a tax of its own
/// and the four-way split, bought by two wallets, sold back in part, bought
/// back and burned on its curve, its cashback and creator fees claimed,
/// graduated into Lester Labs' Uniswap v2 through the live v2 migrator, its
/// liquidity pot joining the pool, traded on the live router both ways,
/// bought back and burned on its pool. Every figure is checked against the
/// fee arithmetic the pad states (the launchpad's fee whole to the treasury,
/// the coin's tax split as configured). A plain coin pays the launchpad's
/// fee alone. Needs a node that serves a fork: the public Caldera node does,
/// slowly.
/// Run with: RUN_FORK_LIVE=true forge test --match-contract LiveLiteforge -vv
///   (FORK_RPC overrides the node; LAUNCHPAD another pad on that chain)
contract LiveLiteforgeForkTest is Test {
    address constant V11_PAD = 0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F;
    uint256 constant BPS = 10_000;

    IPadV11 PAD;
    IMigratorV2 MIGRATOR;
    bool skipAll;
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address whale = makeAddr("whale");

    IPadV11.FeeConfig fees = IPadV11.FeeConfig({
        buyTaxBps: 200, sellTaxBps: 500, creatorBps: 2000, holdersBps: 3000, burnBps: 2500, liquidityBps: 2500
    });

    // the coin under test, kept between the phases below (one function would not fit the stack)
    address token;
    address pair;
    uint256 holdersOfFirstBuy;
    uint256 liqPotAtGraduation;

    struct Split {
        uint256 fee;
        uint256 platform;
        uint256 toCreator;
        uint256 toHolders;
        uint256 toBurn;
        uint256 toLiquidity;
    }

    struct Curve {
        uint256 vEth;
        uint256 vToken;
        uint256 realEth;
        uint256 sold;
        bool graduated;
        address creator;
    }

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork(vm.envOr("FORK_RPC", string("https://liteforge.rpc.caldera.xyz/infra-partner-http")));
        PAD = IPadV11(vm.envOr("LAUNCHPAD", V11_PAD));
        MIGRATOR = IMigratorV2(PAD.migrator());
        vm.deal(creator, 1 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(whale, 100 ether);
    }

    function _meta() internal pure returns (IPadV11.TokenMetadata memory) {
        return IPadV11.TokenMetadata("", "", "", "", "", "");
    }

    /// the pad's split of a trade of `ethIn` at the coin's `taxBps`, as v11 does it: the
    /// launchpad's fee less the pot's share of it to the treasury, the rest of the fee and the
    /// coin's whole tax to the pot, split by the shares (within a few wei of rounding)
    function _split(uint256 ethIn, uint256 taxBps) internal view returns (Split memory x) {
        uint256 f = PAD.feeBps() + taxBps;
        x.fee = (ethIn * f) / BPS;
        uint256 potShare = PAD.creatorFeeShareBps() + PAD.holderCashbackBps();
        x.platform = (((ethIn * PAD.feeBps()) / BPS) * (BPS - potShare)) / BPS;
        uint256 pot = x.fee - x.platform;
        x.toCreator = (pot * fees.creatorBps) / BPS;
        x.toHolders = (pot * fees.holdersBps) / BPS;
        x.toBurn = (pot * fees.burnBps) / BPS;
        x.toLiquidity = (pot * fees.liquidityBps) / BPS;
    }

    function _curve() internal view returns (Curve memory c) {
        (c.vEth, c.vToken, c.realEth, c.sold, c.graduated, c.creator,) = PAD.curves(token);
    }

    function _reserves() internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = IPairView(pair).getReserves();
        (rToken, rQuote) = IPairView(pair).token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function test_live_aTaxedCoinsWholeLife() public {
        if (skipAll) return;
        _bornAndBought();
        _soldBurnedAndClaimed();
        _graduated();
        _tradedOnThePoolAndBoughtBack();
    }

    /// born with its tax and split; alice buys, the launchpad's part to the treasury, the tax
    /// split four ways, the holders' share to the only holder there is, alice; bob buys the same
    function _bornAndBought() internal {
        address treasury = PAD.treasury();
        uint256 treasuryBefore = treasury.balance;
        vm.prank(creator);
        token = PAD.createTokenWithFees("Fork Taxed", "FTAX", 0, _meta(), address(0), fees);
        Curve memory c = _curve();
        assertEq(c.creator, creator);
        assertEq(c.realEth + c.sold, 0);
        assertFalse(c.graduated);
        assertGt(c.vEth, 0, "the curve opens with a virtual reserve");

        uint256 spend = 0.5 ether;
        Split memory x = _split(spend, fees.buyTaxBps);
        vm.prank(alice);
        PAD.buy{value: spend}(token, 0);
        assertEq(_curve().realEth, spend - x.fee, "the curve keeps the spend less the fee");
        assertApproxEqAbs(treasury.balance - treasuryBefore, x.platform, 1e6, "the treasury's part is paid out at once");
        assertApproxEqAbs(PAD.creatorFees(creator, address(0)), x.toCreator, 1e6, "the creator's share accrues");
        assertApproxEqAbs(PAD.burnPot(token), x.toBurn, 1e6, "the burn pot");
        assertApproxEqAbs(PAD.liquidityPot(token), x.toLiquidity, 1e6, "the liquidity pot");
        assertApproxEqAbs(PAD.cashbackOf(token, alice), x.toHolders, 1e6, "the holders' share, all alice's");
        assertGt(IERC20(token).balanceOf(alice), 0);
        holdersOfFirstBuy = x.toHolders;

        vm.prank(bob);
        PAD.buy{value: spend}(token, 0);
        uint256 aliceCb = PAD.cashbackOf(token, alice);
        uint256 bobCb = PAD.cashbackOf(token, bob);
        assertGt(aliceCb, holdersOfFirstBuy, "alice earns on bob's buy too");
        assertGt(bobCb, 0, "bob earns on his own buy");
        assertGt(
            aliceCb - holdersOfFirstBuy, bobCb, "alice holds more than bob (she bought first, cheaper): more of his buy"
        );
    }

    /// alice sells half, taxed at the sell rate; the burn pot buys back on the curve and burns;
    /// alice claims her cashback, the creator the fees, both paid whole in zkLTC
    function _soldBurnedAndClaimed() internal {
        uint256 burnPotBefore = PAD.burnPot(token);
        uint256 half = IERC20(token).balanceOf(alice) / 2;
        uint256 aliceEthBefore = alice.balance;
        vm.startPrank(alice);
        IERC20(token).approve(address(PAD), type(uint256).max);
        PAD.sell(token, half, 0);
        vm.stopPrank();
        assertGt(alice.balance, aliceEthBefore, "sold back for zkLTC");
        assertGt(PAD.burnPot(token), burnPotBefore, "the sell fed the pots too");

        uint256 supplyBefore = IERC20(token).totalSupply();
        uint256 potBefore = PAD.burnPot(token);
        uint256 burnedNow = PAD.buybackAndBurn(token);
        assertGt(burnedNow, 0, "coins bought back and burned");
        assertEq(PAD.burned(token), burnedNow);
        assertEq(IERC20(token).totalSupply(), supplyBefore - burnedNow, "burned for good");
        assertLt(PAD.burnPot(token), potBefore, "the pot spent a slice");

        uint256 owed = PAD.cashbackOf(token, alice);
        uint256 before = alice.balance;
        vm.prank(alice);
        PAD.claimCashback(token);
        assertEq(alice.balance - before, owed, "cashback paid whole");
        assertEq(PAD.cashbackOf(token, alice), 0);
        uint256 cf = PAD.creatorFees(creator, address(0));
        before = creator.balance;
        vm.prank(creator);
        PAD.claimCreatorFees(address(0));
        assertEq(creator.balance - before, cf, "creator fees paid whole");
    }

    /// the whale buys the curve out: graduation seeds Lester Labs' pool in the same transaction,
    /// the liquidity pot joining the quote side, the LP locked in the migrator, the pool opening
    /// at the price the curve closed at
    function _graduated() internal {
        liqPotAtGraduation = PAD.liquidityPot(token);
        for (uint256 i = 0; i < 12; i++) {
            if (_curve().graduated) break;
            vm.prank(whale);
            PAD.buy{value: 1 ether}(token, 0);
        }
        Curve memory c = _curve();
        assertTrue(c.graduated, "12 zkLTC did not graduate a 3 zkLTC curve?");
        assertEq(c.realEth, 0, "the reserve left for the pool");
        assertEq(c.sold, 800_000_000e18, "the curve sold out");
        assertTrue(ILaunchTokenView(token).graduated());
        assertEq(PAD.graduatedVia(token), address(MIGRATOR));
        assertEq(PAD.liquidityPot(token), 0, "the liquidity pot went with the reserve");
        pair = MIGRATOR.pairOf(token);
        assertTrue(pair != address(0), "a pair exists");
        assertGt(MIGRATOR.liquidity(token), 0, "the migrator holds the LP");
        assertEq(IPairView(pair).balanceOf(address(MIGRATOR)), MIGRATOR.liquidity(token), "and it is locked there");
        (uint256 rToken, uint256 rQuote) = _reserves();
        assertGt(rQuote, liqPotAtGraduation, "the quote side holds the raise and the liquidity pot");
        assertLe(rToken, PAD.DEX_RESERVE(), "no more coins than the DEX reserve");
        assertEq(
            IERC20(token).balanceOf(address(PAD)), PAD.lockedAtGraduation(token), "the rest stays locked in the pad"
        );
        assertApproxEqRel(rQuote * c.vToken, c.vEth * rToken, 1e15, "the pool opens at the curve's closing price");
    }

    /// the pool trades on the live router both ways (v11: fees on the curve alone, so the plain
    /// functions serve) and the fees stay in it; the burn pot buys on the pool through the
    /// migrator and burns; what accrued to bob before graduation is still his
    function _tradedOnThePoolAndBoughtBack() internal {
        (uint256 rToken0, uint256 rQuote0) = _reserves();
        IRouterV2 router = IRouterV2(MIGRATOR.router());
        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = token;
        vm.startPrank(bob);
        uint256[] memory amounts = router.swapExactETHForTokens{value: 0.1 ether}(0, path, bob, block.timestamp);
        assertGt(amounts[1], 0, "bought on the pool");
        IERC20(token).approve(address(router), type(uint256).max);
        path[0] = token;
        path[1] = router.WETH();
        uint256 ethBefore = bob.balance;
        router.swapExactTokensForETH(amounts[1], 0, path, bob, block.timestamp);
        vm.stopPrank();
        assertGt(bob.balance, ethBefore, "sold on the pool");
        (uint256 rToken1, uint256 rQuote1) = _reserves();
        assertGe(rToken1 * rQuote1, rToken0 * rQuote0, "the constant product does not shrink");

        if (PAD.burnPot(token) > 0) {
            vm.roll(block.number + 2);
            uint256 burnedBefore = PAD.burned(token);
            uint256 supplyBefore = IERC20(token).totalSupply();
            uint256 got = PAD.buybackAndBurn(token);
            assertGt(got, 0, "bought back on the pool");
            assertEq(PAD.burned(token), burnedBefore + got);
            assertEq(IERC20(token).totalSupply(), supplyBefore - got);
        }

        uint256 bobOwed = PAD.cashbackOf(token, bob);
        assertGt(bobOwed, 0);
        uint256 before = bob.balance;
        vm.prank(bob);
        PAD.claimCashback(token);
        assertEq(bob.balance - before, bobOwed, "cashback claimable after graduation");
    }

    /// a coin with no tax of its own, its pot to the creator: on v11 the launchpad's fee is the
    /// only fee, the treasury keeps its part of it and the creator's share goes to the creator
    function test_live_aPlainCoinPaysTheLaunchpadsFeeAlone() public {
        if (skipAll) return;
        address treasury = PAD.treasury();
        IPadV11.FeeConfig memory none = IPadV11.FeeConfig({
            buyTaxBps: 0, sellTaxBps: 0, creatorBps: 10_000, holdersBps: 0, burnBps: 0, liquidityBps: 0
        });
        vm.prank(creator);
        address plain = PAD.createTokenWithFees("Fork Plain", "FPLN", 0, _meta(), address(0), none);
        uint256 fee = (1 ether * PAD.feeBps()) / BPS;
        uint256 toTreasury = (fee * (BPS - PAD.creatorFeeShareBps() - PAD.holderCashbackBps())) / BPS;
        uint256 before = treasury.balance;
        vm.prank(alice);
        PAD.buy{value: 1 ether}(plain, 0);
        assertApproxEqAbs(treasury.balance - before, toTreasury, 1e6, "the treasury's part of the launchpad's fee");
        assertApproxEqAbs(
            PAD.creatorFees(creator, address(0)), fee - toTreasury, 1e6, "the rest of the fee to the creator"
        );
        assertEq(PAD.cashbackOf(plain, alice), 0, "nothing for holders: the pot is the creator's");
        assertEq(PAD.burnPot(plain) + PAD.liquidityPot(plain), 0);
        (,, uint256 real,,,,) = PAD.curves(plain);
        assertEq(real, 1 ether - fee, "the curve keeps the spend less the fee");
    }
}
