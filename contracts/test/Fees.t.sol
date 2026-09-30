// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";

/// A coin's own fees: its tax on buys and sells, and how its pot is split —
/// creator, holders, buyback-and-burn, liquidity — on the curve and after it.
contract FeesTest is Test {
    Launchpad pad;
    UniV2Migrator migrator;
    MockCbLTC quote;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates every coin
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address cold = makeAddr("cold");
    Launchpad.TokenMetadata meta = Launchpad.TokenMetadata("", "", "", "", "", "");
    /// 3% each way; the pot half to the creator, a fifth to holders, a fifth burned, a tenth to liquidity
    Launchpad.FeeConfig custom = Launchpad.FeeConfig(300, 300, 5000, 2000, 2000, 1000);

    function setUp() public {
        pad = new Launchpad(treasury);
        quote = new MockCbLTC();
        pad.setQuoteAsset(address(quote), 30e8); // as on Base
        pad.setQuoteAsset(address(0), 0);
        MockWETH9 weth = new MockWETH9();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(new MockV2Factory()), address(weth))));
        pad.setMigrator(address(migrator));
    }

    function _create(Launchpad.FeeConfig memory fees) internal returns (address) {
        vm.prank(alice);
        return pad.createTokenWithFees("Taxed Coin", "TAX", 0, meta, address(quote), fees);
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

    function _fees(address token) internal view returns (Launchpad.FeeConfig memory f) {
        (f.buyTaxBps, f.sellTaxBps, f.creatorBps, f.holdersBps, f.burnBps, f.liquidityBps) = pad.feeConfig(token);
    }

    function _reserves(address token) internal view returns (uint256 rToken, uint256 rQuote) {
        address pair = migrator.pairOf(token);
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rToken, rQuote) = MockV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    // ------------------------------------------------------------ the config

    function test_configIsValidatedAndFixed() public {
        vm.startPrank(alice);
        vm.expectRevert(Launchpad.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), Launchpad.FeeConfig(1001, 0, 10_000, 0, 0, 0)); // over the cap
        vm.expectRevert(Launchpad.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), Launchpad.FeeConfig(0, 1001, 10_000, 0, 0, 0));
        vm.expectRevert(Launchpad.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), Launchpad.FeeConfig(0, 0, 5000, 4000, 0, 0)); // shares short
        vm.expectRevert(Launchpad.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), Launchpad.FeeConfig(0, 0, 5000, 5000, 1, 0)); // shares over
        vm.stopPrank();

        address token = _create(custom);
        Launchpad.FeeConfig memory f = _fees(token);
        assertEq(f.buyTaxBps, 300);
        assertEq(f.sellTaxBps, 300);
        assertEq(f.creatorBps, 5000);
        assertEq(f.holdersBps, 2000);
        assertEq(f.burnBps, 2000);
        assertEq(f.liquidityBps, 1000);
        assertTrue(pad.feesToHolders(token), "a holders share counts as rewards");
        assertEq(pad.MAX_TAX_BPS(), 1000);

        // the launch-time choice before taxes is the same thing: no tax, the pot whole to one side
        vm.startPrank(alice);
        address keep = pad.createToken("Keep", "KEEP", 0, meta, address(quote), false);
        address give = pad.createToken("Give", "GIVE", 0, meta, address(quote), true);
        vm.stopPrank();
        assertEq(_fees(keep).creatorBps, 10_000);
        assertEq(_fees(keep).buyTaxBps + _fees(keep).sellTaxBps, 0);
        assertFalse(pad.feesToHolders(keep));
        assertEq(_fees(give).holdersBps, 10_000);
        assertTrue(pad.feesToHolders(give));
    }

    // --------------------------------------------------------------- the tax

    function test_taxedBuyAndSell() public {
        address token = _create(custom);
        uint256 amount = 10e8;
        _buy(bob, token, amount);
        // 1% platform fee and 3% tax off the top; the curve gets the rest
        uint256 fee = (amount * 400) / 10_000;
        assertEq(_curve(token).realEth, amount - fee, "the curve gets what is left after the fee");
        // the treasury: a fifth of the platform fee, straight out, plus rounding dust at most
        uint256 platform = (amount * 100) / 10_000;
        assertGe(quote.balanceOf(treasury), platform / 5);
        assertLe(quote.balanceOf(treasury), platform / 5 + 4);
        // the pot, split as configured
        uint256 pot = fee - platform / 5;
        assertEq(pad.creatorFees(alice, address(quote)), (pot * 5000) / 10_000, "half to the creator");
        assertEq(pad.burnPot(token), (pot * 2000) / 10_000, "a fifth to the burn pot");
        assertEq(pad.liquidityPot(token), (pot * 1000) / 10_000, "a tenth to the liquidity pot");
        assertApproxEqAbs(pad.cashbackOf(token, bob), (pot * 2000) / 10_000, 2, "a fifth to holders: bob alone");

        // a sell: 4% off what the curve pays
        uint256 half = IERC20(token).balanceOf(bob) / 2;
        Launchpad.Curve memory c = _curve(token);
        uint256 out = c.vEth - (c.vEth * c.vToken) / (c.vToken + half);
        uint256 before = quote.balanceOf(bob);
        vm.startPrank(bob);
        IERC20(token).approve(address(pad), half);
        pad.sell(token, half, 0);
        vm.stopPrank();
        assertEq(quote.balanceOf(bob) - before, out - (out * 400) / 10_000);
    }

    function test_zeroTaxCoinIsTheOldSplit() public {
        vm.prank(alice);
        address token = pad.createToken("Keep", "KEEP", 0, meta, address(quote), false);
        _buy(bob, token, 10e8);
        assertEq(_curve(token).realEth, 10e8 - 10e6, "1% off");
        assertEq(pad.creatorFees(alice, address(quote)), (10e6 * 8000) / 10_000, "80% of it to the creator");
        assertEq(quote.balanceOf(treasury), (10e6 * 2000) / 10_000, "20% to the treasury");
        assertEq(pad.burnPot(token) + pad.liquidityPot(token), 0);
    }

    function testFuzz_thePadCoversEveryPotAndClaim(uint256 seed) public {
        address token = _create(custom);
        for (uint256 i = 0; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address who = seed % 2 == 0 ? bob : carol;
            uint256 bal = IERC20(token).balanceOf(who);
            if (seed % 3 == 0 && bal > 1e18) {
                uint256 part = (seed >> 8) % bal + 1;
                vm.startPrank(who);
                IERC20(token).approve(address(pad), part);
                pad.sell(token, part, 0);
                vm.stopPrank();
            } else {
                _buy(who, token, ((seed >> 8) % 5e8) + 1_234_567);
            }
        }
        uint256 owed = _curve(token).realEth + pad.creatorFees(alice, address(quote)) + pad.burnPot(token)
            + pad.liquidityPot(token) + pad.cashbackOf(token, bob) + pad.cashbackOf(token, carol);
        assertGe(quote.balanceOf(address(pad)), owed, "every reserve, pot and claim is backed");
    }

    // -------------------------------------------------------------- the burn

    function test_buybackOnTheCurveBurns() public {
        address token = _create(custom);
        _buy(bob, token, 20e8);
        _buy(carol, token, 20e8);
        uint256 pot = pad.burnPot(token);
        assertGt(pot, 0);
        Launchpad.Curve memory c = _curve(token);
        uint256 expectOut = c.vToken - (c.vEth * c.vToken) / (c.vEth + pot);
        uint256 supply = IERC20(token).totalSupply();
        uint256 bobBal = IERC20(token).balanceOf(bob);

        vm.expectEmit(true, false, false, true);
        emit Launchpad.BoughtBack(token, pot, expectOut);
        uint256 burned = pad.buybackAndBurn(token); // anyone may
        assertEq(burned, expectOut);
        assertEq(pad.burned(token), burned);
        assertEq(pad.burnPot(token), 0);
        assertEq(IERC20(token).totalSupply(), supply - burned, "gone for good");
        assertEq(IERC20(token).balanceOf(bob), bobBal, "holders keep theirs, each a bigger share now");
        Launchpad.Curve memory then = _curve(token);
        assertEq(then.realEth, c.realEth + pot, "the pot became reserve, no fee taken: the price rose");
        assertEq(then.sold, c.sold + burned, "the burned coins left the curve too");
        assertEq(IERC20(token).balanceOf(address(pad)), pad.TOTAL_SUPPLY() - then.sold, "the pad's inventory agrees");
        assertEq(
            IERC20(token).balanceOf(bob) + IERC20(token).balanceOf(carol), then.sold - pad.burned(token), "holders own sold less burned"
        );
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        pad.buybackAndBurn(token); // nothing left in the pot
    }

    function test_buybackCanCloseTheCurveAndThePotsFollow() public {
        // 10% each way, the pot half burned and half liquidity: one big buy leaves a pot that finishes the curve
        address token = _create(Launchpad.FeeConfig(1000, 1000, 0, 0, 5000, 5000));
        _buy(bob, token, 105e8); // 11% off: ~93 cbLTC to a curve that closes at ~96
        assertFalse(_curve(token).graduated);
        uint256 burnPot = pad.burnPot(token);
        uint256 liqPot = pad.liquidityPot(token);
        assertGt(burnPot, 0);
        assertGt(liqPot, 0);

        uint256 burned = pad.buybackAndBurn(token);
        Launchpad.Curve memory c = _curve(token);
        assertTrue(c.graduated, "the buyback sold the curve out");
        assertEq(c.sold, pad.CURVE_SUPPLY());
        assertGt(burned, 0);
        assertGt(pad.burnPot(token), 0, "what the curve did not need stays in the pot");
        assertLt(pad.burnPot(token), burnPot);
        assertEq(pad.liquidityPot(token), 0, "the liquidity pot went into the pool");
        (uint256 rToken, uint256 rQuote) = _reserves(token);
        assertEq(rToken, pad.DEX_RESERVE());
        assertEq(rQuote, (c.vEth - 30e8) + liqPot, "the pool holds the raise and the liquidity pot");

        // graduated: the leftover pot buys on the pool, and burns
        uint256 supply = IERC20(token).totalSupply();
        uint256 leftover = pad.burnPot(token);
        uint256 burned2 = pad.buybackAndBurn(token);
        assertGt(burned2, 0);
        assertEq(pad.burnPot(token), 0);
        assertEq(IERC20(token).totalSupply(), supply - burned2);
        assertEq(pad.burned(token), burned + burned2);
        (uint256 rToken2, uint256 rQuote2) = _reserves(token);
        assertEq(rQuote2, rQuote + leftover, "the pool took the pot");
        assertEq(rToken2, rToken - burned2, "and gave the coins, burned");
    }

    function test_buybackNeedsAPoolOnceGraduated() public {
        pad.setMigrator(address(0));
        address token = _create(custom);
        _buy(bob, token, 200e8); // graduates, its reserve parked here
        assertTrue(_curve(token).graduated);
        assertGt(pad.burnPot(token), 0);
        vm.expectRevert(Launchpad.MigratorNotSet.selector);
        pad.buybackAndBurn(token);
        // its pool seeded later, the buyback has somewhere to buy
        pad.setMigrator(address(migrator));
        pad.migrate(token);
        assertGt(pad.buybackAndBurn(token), 0);
    }

    function test_noBuybackWhileFrozen() public {
        address token = _create(custom);
        _buy(bob, token, 20e8);
        pad.announceFreeze(block.number);
        vm.expectRevert(Launchpad.Frozen.selector);
        pad.buybackAndBurn(token);
    }

    // ---------------------------------------------------------- the migration

    function test_migrateOutTakesThePotsAlong() public {
        address token = _create(custom);
        _buy(bob, token, 20e8);
        uint256 pots = pad.burnPot(token) + pad.liquidityPot(token);
        uint256 reserve = _curve(token).realEth;
        assertGt(pots, 0);
        pad.announceFreeze(block.number);
        (uint256 out,) = pad.migrateOut(token, cold);
        assertEq(out, reserve + pots);
        assertEq(quote.balanceOf(cold), reserve + pots);
        assertEq(pad.burnPot(token) + pad.liquidityPot(token), 0);
    }

    function test_aLedgerCoinArrivesWithItsFeesBurnAndPots() public {
        // the receiving side: a coin as a snapshot recorded it — taxed, a twentieth of it burned, pots unspent
        pad.setMigrationRoot(bytes32(uint256(1)), 1);
        uint256 sold = 100_000_000e18;
        uint256 burnedThere = 5_000_000e18;
        uint256 reserve = Math.mulDiv(1.25 ether, sold, pad.VIRTUAL_TOKEN() - sold);
        Launchpad.LedgerCoin memory coin = Launchpad.LedgerCoin({
            name: "Ledger Coin",
            symbol: "LEDG",
            meta: meta,
            creator: alice,
            fees: custom,
            virtualQuote: 1.25 ether,
            sold: sold,
            burned: burnedThere,
            poolToken: 0,
            burnPot: 0.3 ether,
            liquidityPot: 0.2 ether
        });
        address[] memory holders = new address[](1);
        uint256[] memory balances = new uint256[](1);
        holders[0] = bob;
        balances[0] = sold - burnedThere;
        vm.deal(address(this), reserve + 0.5 ether);
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateToken{value: 0.4 ether}(coin, holders, balances); // less than its pots
        address token = pad.migrateToken{value: reserve + 0.5 ether}(coin, holders, balances);

        assertEq(pad.migrationPending(token), 0, "delivered whole");
        assertEq(IERC20(token).totalSupply(), pad.TOTAL_SUPPLY() - burnedThere, "the burn happened here too");
        assertEq(pad.burned(token), burnedThere);
        assertEq(IERC20(token).balanceOf(bob), sold - burnedThere);
        assertEq(_curve(token).realEth, reserve, "the reserve, the pots aside");
        assertEq(_curve(token).sold, sold);
        assertEq(pad.burnPot(token), 0.3 ether);
        assertEq(pad.liquidityPot(token), 0.2 ether);
        assertEq(_fees(token).sellTaxBps, 300);
        assertTrue(pad.feesToHolders(token));

        // it trades taxed from the first block: a native buy, 4% off
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        pad.buy{value: 1 ether}(token, 0);
        assertEq(_curve(token).realEth, reserve + 0.96 ether);
        // and its pot is there to spend
        assertGt(pad.buybackAndBurn(token), 0);
    }
}
