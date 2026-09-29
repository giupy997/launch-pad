// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {MockWETH9, MockV2Factory, MockV2Pair, MockV2Router} from "./mocks/UniV2Mock.sol";

/// The graduation adapter against a Uniswap v2 pool that anyone may have
/// touched first: the reserve must end up in the pool at the curve's price,
/// whatever was in the pair before.
contract UniV2MigratorTest is Test {
    Launchpad pad;
    MockWETH9 weth;
    MockV2Factory factory;
    UniV2Migrator migrator;
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address buyer = makeAddr("buyer");
    address griefer = makeAddr("griefer");

    function setUp() public {
        pad = new Launchpad(treasury, address(0));
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        vm.deal(buyer, 500 ether);
        vm.deal(griefer, 500 ether);
    }

    function _create() internal returns (address) {
        vm.prank(creator);
        return pad.createToken("Meme", "MEME", 0, Launchpad.TokenMetadata("", "", "", "", "", ""), address(0), false);
    }

    function _reserves(address token) internal view returns (uint256 rToken, uint256 rWeth, address pair) {
        pair = factory.getPair(token, address(weth));
        if (pair == address(0)) return (0, 0, pair);
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rToken, rWeth) = MockV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Pool price in wei per token, vs the price the migrator was given.
    function _assertPriceNear(uint256 rToken, uint256 rWeth, uint256 wantWeth, uint256 wantToken, uint256 bps) internal pure {
        uint256 pool = rWeth * 1e18 / rToken;
        uint256 want = wantWeth * 1e18 / wantToken;
        uint256 diff = pool > want ? pool - want : want - pool;
        assertLe(diff * 10_000, want * bps, "pool price off the curve's");
    }

    function test_freshPairSeedsAtTheCurvePrice() public {
        pad.setMigrator(address(migrator));
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0); // crosses graduation, auto-migrates
        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(realEth, 0, "auto-migrated in the same transaction");
        (uint256 rToken, uint256 rWeth, address pair) = _reserves(token);
        assertEq(rToken, pad.DEX_RESERVE(), "the whole reserve is in the pool");
        assertGt(rWeth, 0);
        assertEq(IERC20(token).balanceOf(treasury), 0, "nothing swept aside");
        assertEq(MockV2Pair(pair).balanceOf(address(migrator)), migrator.liquidity(token));
        assertGt(migrator.liquidity(token), 0, "the LP tokens are locked in the adapter");
    }

    /// Anyone can create the pair first and put the quote side in it (the
    /// token cannot move before graduation). The router's addLiquidity would
    /// divide by zero on that; the adapter absorbs it, our deposit sets the price.
    function test_aDonatedQuoteSideIsAbsorbed() public {
        pad.setMigrator(address(migrator));
        address token = _create();
        address pair = factory.createPair(token, address(weth));
        vm.startPrank(griefer);
        weth.deposit{value: 5 ether}();
        weth.transfer(pair, 5 ether);
        MockV2Pair(pair).sync();
        vm.stopPrank();

        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0);
        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(realEth, 0, "the migration went through despite the pre-existing pair");
        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        assertEq(rToken, pad.DEX_RESERVE());
        assertGt(rWeth, 5 ether, "the donation stays in the pool, on top of the raise");
        assertEq(IERC20(token).balanceOf(treasury), 0);
        assertGt(migrator.liquidity(token), 0);
    }

    /// Funds parked after graduation (here: no migrator was set) leave a
    /// window in which transfers are open and someone can mint liquidity at a
    /// wild price. The adapter trades the pool back to the curve's price
    /// before joining it, so the reserve is neither swept aside nor seeded at
    /// the manipulated price.
    function test_aSkewedPoolIsRebalancedBeforeSeeding() public {
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0); // graduates; nothing migrates yet
        (,, uint256 parked,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertGt(parked, 0, "the raise waits in the launchpad");

        // 1 token : 20 WETH — twenty thousand times the curve's price
        address pair = factory.createPair(token, address(weth));
        vm.prank(buyer);
        IERC20(token).transfer(pair, 1e18);
        vm.startPrank(griefer);
        weth.deposit{value: 20 ether}();
        weth.transfer(pair, 20 ether);
        MockV2Pair(pair).mint(griefer);
        vm.stopPrank();

        pad.setMigrator(address(migrator));
        pad.migrate(token); // anyone may

        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        _assertPriceNear(rToken, rWeth, parked, pad.DEX_RESERVE(), 100); // within 1%
        assertGt(rToken, pad.DEX_RESERVE() * 99 / 100, "(almost) the whole reserve reached the pool");
        assertLt(IERC20(token).balanceOf(treasury), pad.DEX_RESERVE() / 100, "not swept to the treasury");
        assertGt(migrator.liquidity(token), 0);
        // the griefer's liquidity was traded against: it is worth less than the 20 WETH put in
        uint256 share = MockV2Pair(pair).balanceOf(griefer) * 1e18 / MockV2Pair(pair).totalSupply();
        assertLt(rWeth * share / 1e18, 20 ether, "the manipulator paid for the manipulation");
    }

    function test_aPoolWithTokensTooCheapIsRebalancedToo() public {
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0);
        (,, uint256 parked,,,,) = pad.curves(token);

        // lots of tokens against almost no WETH: a price far below the curve's
        address pair = factory.createPair(token, address(weth));
        vm.prank(buyer);
        IERC20(token).transfer(pair, 50_000_000e18);
        vm.startPrank(griefer);
        weth.deposit{value: 0.001 ether}();
        weth.transfer(pair, 0.001 ether);
        MockV2Pair(pair).mint(griefer);
        vm.stopPrank();

        pad.setMigrator(address(migrator));
        pad.migrate(token);
        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        _assertPriceNear(rToken, rWeth, parked, pad.DEX_RESERVE(), 100);
        assertGt(migrator.liquidity(token), 0);
    }

    function test_onlyTheLaunchpadMigrates() public {
        vm.expectRevert(UniV2Migrator.OnlyLaunchpad.selector);
        migrator.migrate{value: 1 ether}(address(weth), 1e18, address(0), 0);
    }
}
