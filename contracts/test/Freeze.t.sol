// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";

/// The migration to another chain, from this side: the freeze that makes the
/// snapshot final, and migrateOut, which takes each coin's quote to the bridge.
contract FreezeTest is Test {
    Launchpad pad;
    UniV2Migrator migrator;
    MockCbLTC quote;
    MockV2Factory factory;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates both coins
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave"); // graduates the second coin
    address cold = makeAddr("cold"); // the account that bridges
    address curveCoin;
    address gradCoin;
    Launchpad.TokenMetadata meta = Launchpad.TokenMetadata("", "", "", "", "", "");

    function setUp() public {
        pad = new Launchpad(treasury, address(0));
        quote = new MockCbLTC();
        pad.setQuoteAsset(address(quote), 30e8); // 30 cbLTC virtual, as on Base
        MockWETH9 weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        pad.setMigrator(address(migrator));

        vm.startPrank(alice);
        curveCoin = pad.createToken("Curve Coin", "CURVE", 0, meta, address(quote), false);
        gradCoin = pad.createToken("Grad Coin", "GRAD", 0, meta, address(quote), false);
        vm.stopPrank();

        _buy(bob, curveCoin, 5e8);
        _buy(carol, curveCoin, 3e8);
        _buy(dave, gradCoin, 200e8); // the curve raises ~96 cbLTC: this graduates it and refunds the rest
        assertTrue(_curve(gradCoin).graduated, "GRAD graduated");
        assertGt(migrator.liquidity(gradCoin), 0, "its pool is seeded and locked");
    }

    function _buy(address who, address token, uint256 amount) internal {
        quote.mint(who, amount);
        vm.startPrank(who);
        quote.approve(address(pad), amount);
        pad.buyWithQuote(token, amount, 0);
        vm.stopPrank();
    }

    function _curve(address token) internal view returns (Launchpad.Curve memory c) {
        (c.vEth, c.vToken, c.realEth, c.sold, c.graduated, c.creator, c.quoteAsset) = pad.curves(token);
    }

    function _freeze() internal {
        pad.announceFreeze(block.number + 5);
        vm.roll(block.number + 5);
        assertTrue(pad.frozen());
    }

    // ------------------------------------------------------------ the freeze

    function test_announcedFreezeLandsAtItsBlock() public {
        vm.prank(bob);
        vm.expectRevert();
        pad.announceFreeze(block.number + 5); // owner only

        pad.announceFreeze(block.number + 5);
        assertFalse(pad.frozen(), "announced, not landed: trading goes on");
        _buy(bob, curveCoin, 1e8);
        vm.roll(block.number + 4);
        assertFalse(pad.frozen());
        vm.roll(block.number + 1);
        assertTrue(pad.frozen());
    }

    function test_frozenLaunchpadStandsStill() public {
        _freeze();

        quote.mint(bob, 1e8);
        vm.startPrank(bob);
        quote.approve(address(pad), 1e8);
        vm.expectRevert(Launchpad.Frozen.selector);
        pad.buyWithQuote(curveCoin, 1e8, 0);
        uint256 bal = IERC20(curveCoin).balanceOf(bob);
        IERC20(curveCoin).approve(address(pad), bal);
        vm.expectRevert(Launchpad.Frozen.selector);
        pad.sell(curveCoin, bal, 0);
        vm.expectRevert(Launchpad.Frozen.selector);
        pad.createToken("Late", "LATE", 0, meta, address(quote), false);
        vm.stopPrank();

        // a graduated coin trades freely on its DEX until the freeze: then not even a transfer
        vm.prank(dave);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(bob, 1e18);

        // a graduated coin whose pool was never seeded cannot be seeded now either
        vm.expectRevert(Launchpad.Frozen.selector);
        pad.migrate(gradCoin);
    }

    function test_claimsKeepWorkingWhileFrozen() public {
        uint256 owed = pad.creatorFees(alice, address(quote));
        assertGt(owed, 0, "alice earned creator fees on the buys");
        _freeze();
        vm.prank(alice);
        pad.claimCreatorFees(address(quote));
        assertEq(quote.balanceOf(alice), owed);
    }

    function test_freezeCanBeCancelledOnlyBeforeItLands() public {
        pad.announceFreeze(block.number + 5);
        vm.expectRevert(Launchpad.BadFreeze.selector);
        pad.announceFreeze(block.number + 6); // one at a time
        pad.cancelFreeze();
        assertEq(pad.freezeBlock(), 0);
        _buy(bob, curveCoin, 1e8);

        vm.expectRevert(Launchpad.BadFreeze.selector);
        pad.announceFreeze(block.number - 1); // never in the past

        _freeze();
        vm.expectRevert(Launchpad.BadFreeze.selector);
        pad.cancelFreeze(); // landed: no way back
    }

    // ---------------------------------------------------------- migrateOut

    function test_migrateOutNeedsTheFreezeAndTheOwner() public {
        vm.expectRevert(Launchpad.NotFrozen.selector);
        pad.migrateOut(curveCoin, cold);
        _freeze();
        vm.prank(bob);
        vm.expectRevert();
        pad.migrateOut(curveCoin, cold);
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        pad.migrateOut(curveCoin, address(0));
    }

    function test_migrateOutTakesACurveCoinsReserveWhole() public {
        uint256 reserve = _curve(curveCoin).realEth;
        assertGt(reserve, 0);
        uint256 padBefore = quote.balanceOf(address(pad));
        _freeze();

        (uint256 quoteOut, uint256 burned) = pad.migrateOut(curveCoin, cold);
        assertEq(quoteOut, reserve, "exactly the reserve, as the curve recorded it");
        assertEq(burned, 0, "a curve coin has no pool side to burn");
        assertEq(quote.balanceOf(cold), reserve);
        assertEq(_curve(curveCoin).realEth, 0);
        assertTrue(pad.migratedOut(curveCoin));
        // what holders own is untouched, and so is the price the snapshot reads
        assertEq(IERC20(curveCoin).balanceOf(bob) + IERC20(curveCoin).balanceOf(carol), _curve(curveCoin).sold);
        assertEq(_curve(curveCoin).vEth, 30e8 + reserve, "the virtual reserve still tells the price");
        // fees owed to the creator stayed behind: the reserve was the only thing that left
        assertEq(quote.balanceOf(address(pad)), padBefore - reserve);
        assertGe(quote.balanceOf(address(pad)), pad.creatorFees(alice, address(quote)));

        vm.expectRevert(Launchpad.AlreadyMigratedOut.selector);
        pad.migrateOut(curveCoin, cold);
    }

    function test_migrateOutUnlocksAGraduatedCoinsPool() public {
        address pair = migrator.pairOf(gradCoin);
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (uint256 rToken, uint256 rQuote) = MockV2Pair(pair).token0() == gradCoin ? (r0, r1) : (r1, r0);
        uint256 supplyBefore = IERC20(gradCoin).totalSupply();
        uint256 daveBefore = IERC20(gradCoin).balanceOf(dave);
        _freeze();

        (uint256 quoteOut, uint256 burned) = pad.migrateOut(gradCoin, cold);
        // our LP is the whole pool but Uniswap's minimum liquidity: what comes back is (nearly) all of it
        assertGe(quoteOut, rQuote * 999 / 1000, "the pool's quote side, to the bridge");
        assertLe(quoteOut, rQuote);
        assertEq(quote.balanceOf(cold), quoteOut);
        assertGe(burned, rToken * 999 / 1000, "the pool's token side, burned");
        assertEq(IERC20(gradCoin).totalSupply(), supplyBefore - burned, "the supply left is what holders own");
        assertEq(IERC20(gradCoin).balanceOf(dave), daveBefore, "holders keep theirs");
        assertEq(migrator.liquidity(gradCoin), 0);
        assertEq(pad.unlocking(), address(0), "the transfer window closed again");
        assertTrue(pad.migratedOut(gradCoin));

        // still frozen for everyone else
        vm.prank(dave);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(bob, 1e18);
    }

    function test_migrateOutOfAGraduatedCoinParkedHere() public {
        // a coin that graduates with no migrator set keeps its reserve here; migrateOut takes it like a curve's
        pad.setMigrator(address(0));
        vm.prank(alice);
        address parked = pad.createToken("Parked", "PARK", 0, meta, address(quote), false);
        _buy(dave, parked, 200e8);
        assertTrue(_curve(parked).graduated);
        uint256 reserve = _curve(parked).realEth;
        assertGt(reserve, 0, "graduated, reserve still here");
        _freeze();
        (uint256 quoteOut, uint256 burned) = pad.migrateOut(parked, cold);
        assertEq(quoteOut, reserve);
        assertEq(burned, 0);
        assertEq(_curve(parked).realEth, 0);
    }
}
