// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, stdError} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";

/// The fees on a coin: the launchpad's 0.5% a side, whole to the treasury,
/// and the coin's own tax on buys and sells — the only source of its four
/// shares, creator, holders, buyback-and-burn, liquidity, split as its
/// FeeConfig says — on the curve, in the quote, and on its pool after
/// graduation, in coins the harvest sells later.
contract FeesTest is Test {
    Launchpad pad;
    ILaunchpadMigration mig;
    UniV2Migrator migrator;
    MockCbLTC quote;
    MockWETH9 weth;
    MockV2Factory factory;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates every coin
    address bob = makeAddr("bob"); // graduates the pool coins: holds the curve supply
    address carol = makeAddr("carol"); // trades on the pool
    address cold = makeAddr("cold");
    LaunchpadBase.TokenMetadata meta = LaunchpadBase.TokenMetadata("", "", "", "", "", "");
    /// 3% each way; the pot half to the creator, a fifth to holders, a fifth burned, a tenth to liquidity
    LaunchpadBase.FeeConfig custom = LaunchpadBase.FeeConfig(300, 300, 5000, 2000, 2000, 1000, 0);
    /// 2% on buys, 4% on sells, the same split: a pool's two rates can be told apart
    LaunchpadBase.FeeConfig asym = LaunchpadBase.FeeConfig(200, 400, 5000, 2000, 2000, 1000, 0);
    /// The launchpad's fee as deployed, stamped on every coin: 0.5%
    uint256 constant PLATFORM = 50;

    function setUp() public {
        pad = new Launchpad(treasury);
        mig = ILaunchpadMigration(address(pad));
        quote = new MockCbLTC();
        pad.setQuoteAsset(address(quote), 30e8); // as on Base
        pad.setQuoteAsset(address(0), 0);
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        pad.setMigrator(address(migrator));
    }

    function _create(LaunchpadBase.FeeConfig memory fees) internal returns (address) {
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

    /// A coin graduated by one big buy of bob's: its pool is seeded, locked and registered; bob holds the curve supply.
    function _graduate(LaunchpadBase.FeeConfig memory fees) internal returns (address token, address pair) {
        token = _create(fees);
        _buy(bob, token, 200e8); // the curve raises 96 cbLTC plus the fee: this graduates it and refunds the rest
        assertTrue(_curve(token).graduated, "graduated");
        pair = migrator.pairOf(token);
        assertGt(migrator.liquidity(token), 0, "its pool is seeded and locked");
    }

    function _curve(address token) internal view returns (LaunchpadBase.Curve memory c) {
        (c.vEth, c.vToken, c.realEth, c.sold, c.graduated, c.creator, c.quoteAsset) = pad.curves(token);
    }

    function _fees(address token) internal view returns (LaunchpadBase.FeeConfig memory f) {
        (f.buyTaxBps, f.sellTaxBps, f.creatorBps, f.holdersBps, f.burnBps, f.liquidityBps, f.platformBps) = pad.feeConfig(token);
    }

    function _reserves(address token) internal view returns (uint256 rToken, uint256 rQuote) {
        return _reservesOf(migrator.pairOf(token), token);
    }

    /// A pool's reserves as (coin, the other side), whatever their order in the pair.
    function _reservesOf(address pair, address token) internal view returns (uint256 rToken, uint256 rOther) {
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rToken, rOther) = MockV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Uniswap v2's getAmountOut: the pool's own 0.3% on the way in.
    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        return (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
    }

    /// The swap arguments that take `out` of one side: the coin when `wantToken`, the other side otherwise.
    function _outs(address pair, address token, uint256 out, bool wantToken)
        internal
        view
        returns (uint256 out0, uint256 out1)
    {
        bool tokenIsZero = MockV2Pair(pair).token0() == token;
        return wantToken == tokenIsZero ? (out, uint256(0)) : (uint256(0), out);
    }

    /// Take `out` of one side from the pair for `to`: the coin when `wantToken`, the other side otherwise.
    function _swap(address pair, address token, uint256 out, bool wantToken, address to) internal {
        (uint256 out0, uint256 out1) = _outs(pair, token, out, wantToken);
        MockV2Pair(pair).swap(out0, out1, to, "");
    }

    /// A buy on the pool, as a router does it: the quote to the pair, the coins swapped out to `who`.
    /// Returns what the pair paid out — before the tax the coin takes on the way.
    function _poolBuy(address who, address token, address pair, uint256 quoteIn) internal returns (uint256 out) {
        (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
        out = _amountOut(quoteIn, rQuote, rToken);
        (uint256 out0, uint256 out1) = _outs(pair, token, out, true);
        quote.mint(who, quoteIn);
        vm.startPrank(who);
        quote.transfer(pair, quoteIn);
        MockV2Pair(pair).swap(out0, out1, who, "");
        vm.stopPrank();
    }

    /// A sell on the pool: the coins to the pair — taxed on the way, so the pair gets the net — and the
    /// quote the net buys swapped out to `who`.
    function _poolSell(address who, address token, address pair, uint256 tokensIn)
        internal
        returns (uint256 net, uint256 quoteOut)
    {
        net = tokensIn - (tokensIn * pad.transferRate(token, who, pair)) / 10_000;
        (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
        quoteOut = _amountOut(net, rToken, rQuote);
        (uint256 out0, uint256 out1) = _outs(pair, token, quoteOut, false);
        vm.startPrank(who);
        IERC20(token).transfer(pair, tokensIn);
        MockV2Pair(pair).swap(out0, out1, who, "");
        vm.stopPrank();
    }

    /// How the pad books a tax taken at `rate`: the launchpad's part by platformBps over the rate, the rest the coin's.
    function _split(uint256 tax, uint256 rate) internal pure returns (uint256 platform, uint256 pot) {
        platform = (tax * PLATFORM) / rate;
        pot = tax - platform;
    }

    /// The pool holds no cashback, nor the pad, nor the migrator: what everyone else holds is the eligible supply.
    function _assertEligible(address token, address pair) internal view {
        assertEq(
            pad.eligibleSupply(token),
            IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad)) - IERC20(token).balanceOf(pair)
                - IERC20(token).balanceOf(address(migrator)),
            "eligible supply: everything but the pad's, the pool's and the migrator's"
        );
    }

    // ------------------------------------------------------------ the config

    function test_configIsValidatedAndFixed() public {
        vm.startPrank(alice);
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), LaunchpadBase.FeeConfig(1001, 0, 10_000, 0, 0, 0, 0)); // over the cap
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), LaunchpadBase.FeeConfig(0, 1001, 10_000, 0, 0, 0, 0));
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), LaunchpadBase.FeeConfig(0, 0, 5000, 4000, 0, 0, 0)); // shares short
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        pad.createTokenWithFees("A", "A", 0, meta, address(quote), LaunchpadBase.FeeConfig(0, 0, 5000, 5000, 1, 0, 0)); // shares over
        vm.stopPrank();

        address token = _create(custom);
        LaunchpadBase.FeeConfig memory f = _fees(token);
        assertEq(f.buyTaxBps, 300);
        assertEq(f.sellTaxBps, 300);
        assertEq(f.creatorBps, 5000);
        assertEq(f.holdersBps, 2000);
        assertEq(f.burnBps, 2000);
        assertEq(f.liquidityBps, 1000);
        assertEq(f.platformBps, 50, "the launchpad's fee as it stood, stamped on the coin");
        assertTrue(pad.feesToHolders(token), "a holders share counts as rewards");
        assertEq(pad.MAX_TAX_BPS(), 1000);

        // the launch-time choice before taxes is the same thing: no tax, the (empty) shares whole to one side
        vm.startPrank(alice);
        address keep = pad.createToken("Keep", "KEEP", 0, meta, address(quote), false);
        address give = pad.createToken("Give", "GIVE", 0, meta, address(quote), true);
        vm.stopPrank();
        assertEq(_fees(keep).creatorBps, 10_000);
        assertEq(_fees(keep).buyTaxBps + _fees(keep).sellTaxBps, 0);
        assertEq(_fees(keep).platformBps, 50);
        assertFalse(pad.feesToHolders(keep));
        assertEq(_fees(give).holdersBps, 10_000);
        assertTrue(pad.feesToHolders(give));
    }

    /// The launchpad's rate is the pad's, not the creator's word, and a coin keeps the one it launched with:
    /// a change of feeBps reaches coins created afterwards only, so a live coin's total tax never moves.
    function test_theLaunchpadRateIsStampedAtLaunch() public {
        assertEq(pad.feeBps(), PLATFORM, "0.5% as deployed");
        assertEq(pad.MAX_FEE_BPS(), 500);
        LaunchpadBase.FeeConfig memory f = custom;
        f.platformBps = 999; // whatever the creator writes there
        address early = _create(f);
        assertEq(_fees(early).platformBps, 50, "the launchpad's rate as it stands, overwriting the creator's");

        pad.setFeeBps(100);
        address late = _create(custom);
        assertEq(_fees(early).platformBps, 50, "a live coin keeps the rate it launched with");
        assertEq(_fees(late).platformBps, 100, "a later coin takes the new one");
        _buy(bob, early, 10e8);
        _buy(bob, late, 10e8);
        assertEq(_curve(early).realEth, 10e8 - (10e8 * 350) / 10_000, "0.5% + 3% off");
        assertEq(_curve(late).realEth, 10e8 - (10e8 * 400) / 10_000, "1% + 3% off");
        assertEq(quote.balanceOf(treasury), 0.05e8 + 0.1e8, "each coin's launchpad part, whole");

        vm.expectRevert(LaunchpadBase.FeeTooHigh.selector);
        pad.setFeeBps(501); // 5% at most
        pad.setFeeBps(0);
        assertEq(_fees(_create(custom)).platformBps, 0, "and a free launchpad stamps zero");
    }

    // --------------------------------------------------------------- the tax

    function test_taxedBuyAndSell() public {
        address token = _create(custom);
        uint256 amount = 10e8;
        _buy(bob, token, amount);
        {
            // the 0.5% launchpad fee and the 3% tax come off the top together; the curve gets the rest
            uint256 fee = (amount * 350) / 10_000;
            assertEq(fee, 0.35e8);
            assertEq(_curve(token).realEth, amount - fee, "the curve gets what is left after the fee");
            // the launchpad's part — the fee at its rate, 0.5% of the trade — straight to the treasury, whole
            (uint256 platform, uint256 pot) = _split(fee, 350);
            assertEq(platform, 0.05e8);
            assertEq(quote.balanceOf(treasury), platform, "0.5% to the treasury, nothing of the tax");
            // the tax is the pot, split as configured: round figures, no dust
            assertEq(pot, 0.3e8);
            assertEq(pad.creatorFees(alice, address(quote)), (pot * 5000) / 10_000, "half to the creator");
            assertEq(pad.burnPot(token), (pot * 2000) / 10_000, "a fifth to the burn pot");
            assertEq(pad.liquidityPot(token), (pot * 1000) / 10_000, "a tenth to the liquidity pot");
            assertApproxEqAbs(pad.cashbackOf(token, bob), (pot * 2000) / 10_000, 2, "a fifth to holders: bob alone");
        }

        // a sell: 3.5% off what the curve pays, booked the same way
        uint256 half = IERC20(token).balanceOf(bob) / 2;
        uint256 out;
        {
            LaunchpadBase.Curve memory c = _curve(token);
            out = c.vEth - (c.vEth * c.vToken) / (c.vToken + half);
        }
        uint256 before = quote.balanceOf(bob);
        uint256 treasuryBefore = quote.balanceOf(treasury);
        uint256 creatorBefore = pad.creatorFees(alice, address(quote));
        vm.startPrank(bob);
        IERC20(token).approve(address(pad), half);
        pad.sell(token, half, 0);
        vm.stopPrank();
        uint256 sellFee = (out * 350) / 10_000;
        assertEq(quote.balanceOf(bob) - before, out - sellFee, "3.5% off what the curve pays");
        (uint256 sellPlatform, uint256 sellPot) = _split(sellFee, 350);
        // not round this time: what the four shares leave over goes to the treasury with the launchpad's part
        uint256 toCreator = (sellPot * 5000) / 10_000;
        uint256 dust = sellPot - toCreator - (sellPot * 2000) / 10_000 - (sellPot * 2000) / 10_000 - (sellPot * 1000) / 10_000;
        assertEq(quote.balanceOf(treasury) - treasuryBefore, sellPlatform + dust, "the launchpad's part, and the rounding");
        assertEq(pad.creatorFees(alice, address(quote)) - creatorBefore, toCreator);
    }

    /// A coin with no tax of its own pays the launchpad's 0.5% and nothing else: v11's split of the platform
    /// fee into the coin's shares is gone, so the creator and the holders get nothing from such a coin.
    function test_aTaxlessCoinPaysTheLaunchpadFeeAlone() public {
        vm.prank(alice);
        address token = pad.createToken("Keep", "KEEP", 0, meta, address(quote), false);
        _buy(bob, token, 10e8);
        assertEq(_curve(token).realEth, 10e8 - 0.05e8, "0.5% off");
        assertEq(quote.balanceOf(treasury), 0.05e8, "whole to the treasury");
        assertEq(pad.creatorFees(alice, address(quote)), 0, "the launchpad's fee feeds no share: nothing for the creator");
        assertEq(pad.burnPot(token) + pad.liquidityPot(token) + pad.cashbackOf(token, bob), 0);
        // nor for the holders of a coin that would have given its tax to them
        vm.prank(alice);
        address give = pad.createToken("Give", "GIVE", 0, meta, address(quote), true);
        _buy(bob, give, 10e8);
        assertEq(quote.balanceOf(treasury), 0.1e8);
        assertEq(pad.cashbackOf(give, bob), 0, "no tax, no cashback");
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
        LaunchpadBase.Curve memory c = _curve(token);
        uint256 expectOut = c.vToken - (c.vEth * c.vToken) / (c.vEth + pot);
        uint256 supply = IERC20(token).totalSupply();
        uint256 bobBal = IERC20(token).balanceOf(bob);

        vm.expectEmit(true, false, false, true);
        emit LaunchpadBase.BoughtBack(token, pot, expectOut);
        uint256 burned = pad.buybackAndBurn(token); // anyone may
        assertEq(burned, expectOut);
        assertEq(pad.burned(token), burned);
        assertEq(pad.burnPot(token), 0);
        assertEq(IERC20(token).totalSupply(), supply - burned, "gone for good");
        assertEq(IERC20(token).balanceOf(bob), bobBal, "holders keep theirs, each a bigger share now");
        LaunchpadBase.Curve memory then = _curve(token);
        assertEq(then.realEth, c.realEth + pot, "the pot became reserve, no fee taken: the price rose");
        assertEq(then.sold, c.sold + burned, "the burned coins left the curve too");
        assertEq(IERC20(token).balanceOf(address(pad)), pad.TOTAL_SUPPLY() - then.sold, "the pad's inventory agrees");
        assertEq(
            IERC20(token).balanceOf(bob) + IERC20(token).balanceOf(carol), then.sold - pad.burned(token), "holders own sold less burned"
        );
        vm.roll(block.number + 1);
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        pad.buybackAndBurn(token); // nothing left in the pot
    }

    function test_buybackCanCloseTheCurveAndThePotsFollow() public {
        // 10% each way, the tax half burned and half liquidity: one big buy leaves a pot that finishes the curve
        address token = _create(LaunchpadBase.FeeConfig(1000, 1000, 0, 0, 5000, 5000, 0));
        _buy(bob, token, 105e8); // 10.5% off: 93.975 cbLTC to a curve that closes at 96
        assertFalse(_curve(token).graduated);
        assertEq(_curve(token).realEth, 93.975e8);
        uint256 burnPot = pad.burnPot(token);
        uint256 liqPot = pad.liquidityPot(token);
        assertEq(burnPot, 5.25e8, "half the 10% tax (the launchpad's 0.5% is not in it)");
        assertEq(liqPot, 5.25e8, "the other half");

        // a slice a block — a hundredth of the virtual reserve, 1.24 cbLTC — against the 2.025 cbLTC the
        // curve still needs: two presses finish it (v11's 1% platform fee left the curve 3 presses short)
        uint256 burned;
        uint256 presses;
        while (!_curve(token).graduated) {
            vm.roll(block.number + 1);
            burned += pad.buybackAndBurn(token);
            presses++;
        }
        assertEq(presses, 2, "a hundredth of the reserve at a time");
        LaunchpadBase.Curve memory c = _curve(token);
        assertEq(c.sold, pad.CURVE_SUPPLY());
        assertGt(burned, 0);
        assertGt(pad.burnPot(token), 0, "what the curve did not need stays in the pot");
        assertLt(pad.burnPot(token), burnPot);
        assertEq(pad.liquidityPot(token), 0, "the liquidity pot went into the pool");
        (uint256 rToken, uint256 rQuote) = _reserves(token);
        assertEq(rToken + pad.lockedAtGraduation(token), pad.DEX_RESERVE(), "the pool and the lock share the DEX reserve");
        assertEq(rQuote, (c.vEth - 30e8) + liqPot, "the pool holds the raise and the liquidity pot");
        // against coins at the closing price, never more than the reserve: a pot this big asks for more
        // than the 200M, so the whole reserve goes in and the pool opens above the closing price
        uint256 atClosing = (rQuote * c.vToken) / c.vEth;
        assertEq(rToken, atClosing > pad.DEX_RESERVE() ? pad.DEX_RESERVE() : atClosing, "coins at the closing price, capped by the reserve");

        // graduated: the leftover pot buys on the pool, a two-hundredth of its quote side at a time, and burns
        uint256 supply = IERC20(token).totalSupply();
        uint256 leftover = pad.burnPot(token);
        uint256 cap = migrator.buybackCap(token);
        assertEq(cap, rQuote / 200);
        assertLt(cap, leftover);
        vm.roll(block.number + 1);
        uint256 burned2 = pad.buybackAndBurn(token);
        assertGt(burned2, 0);
        assertEq(pad.burnPot(token), leftover - cap, "the rest waits for the next block");
        assertEq(IERC20(token).totalSupply(), supply - burned2);
        assertEq(pad.burned(token), burned + burned2);
        (uint256 rToken2, uint256 rQuote2) = _reserves(token);
        assertEq(rQuote2, rQuote + cap, "the pool took the slice");
        assertEq(rToken2, rToken - burned2, "and gave the coins, burned");
    }

    function test_buybackIsASliceABlock() public {
        address token = _create(LaunchpadBase.FeeConfig(1000, 1000, 0, 0, 10_000, 0, 0)); // the pot fills fast
        _buy(bob, token, 50e8);
        LaunchpadBase.Curve memory c = _curve(token);
        uint256 pot = pad.burnPot(token);
        assertGt(pot, c.vEth / 100, "more in the pot than one slice");
        pad.buybackAndBurn(token);
        assertEq(_curve(token).realEth, c.realEth + c.vEth / 100, "one hundredth of the virtual reserve, no more");
        assertEq(pad.burnPot(token), pot - c.vEth / 100);
        vm.expectRevert(LaunchpadBase.BurnCooldown.selector);
        pad.buybackAndBurn(token); // not twice in a block
        vm.roll(block.number + 1);
        pad.buybackAndBurn(token); // the next block, the next slice
        assertLt(pad.burnPot(token), pot - c.vEth / 100);
    }

    function test_buybackNeedsAPoolOnceGraduated() public {
        pad.setMigrator(address(0));
        address token = _create(custom);
        _buy(bob, token, 200e8); // graduates, its reserve parked here
        assertTrue(_curve(token).graduated);
        assertGt(pad.burnPot(token), 0);
        vm.expectRevert(LaunchpadBase.MigratorNotSet.selector);
        pad.buybackAndBurn(token);
        assertEq(pad.transferRate(token, bob, carol), 0, "graduated with no pool: nothing to tax yet");
        // its pool seeded later, the buyback has somewhere to buy — and the pool is a counterparty from then on
        pad.setMigrator(address(migrator));
        pad.migrate(token);
        assertTrue(pad.taxedPool(token, migrator.pairOf(token)), "registered by the late migration too");
        assertGt(pad.buybackAndBurn(token), 0);
    }

    function test_noBuybackWhileFrozen() public {
        address token = _create(custom);
        _buy(bob, token, 20e8);
        mig.announceFreeze(block.number);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.buybackAndBurn(token);
    }

    // ---------------------------------------------------------- the migration

    function test_migrateOutTakesThePotsAlong() public {
        address token = _create(custom);
        _buy(bob, token, 20e8);
        uint256 pots = pad.burnPot(token) + pad.liquidityPot(token);
        uint256 reserve = _curve(token).realEth;
        assertGt(pots, 0);
        mig.announceFreeze(block.number);
        (uint256 out,) = mig.migrateOut(token, cold);
        assertEq(out, reserve + pots);
        assertEq(quote.balanceOf(cold), reserve + pots);
        assertEq(pad.burnPot(token) + pad.liquidityPot(token), 0);
    }

    function test_aLedgerCoinArrivesWithItsFeesBurnAndPots() public {
        // the receiving side: a coin as a snapshot recorded it — taxed, a twentieth of it burned, pots unspent
        mig.setMigrationRoot(bytes32(uint256(1)), 1);
        uint256 sold = 100_000_000e18;
        uint256 burnedThere = 5_000_000e18;
        uint256 reserve = Math.mulDiv(1.25 ether, sold, pad.VIRTUAL_TOKEN() - sold);
        LaunchpadBase.FeeConfig memory ledgerFees = custom;
        ledgerFees.platformBps = 100; // the ledger's launchpad fee: not this launchpad's
        LaunchpadBase.LedgerCoin memory coin = LaunchpadBase.LedgerCoin({
            name: "Ledger Coin",
            symbol: "LEDG",
            meta: meta,
            creator: alice,
            feeRecipient: address(0),
            fees: ledgerFees,
            quoteAsset: address(0),
            quoteAmount: reserve + 0.5 ether,
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
        coin.quoteAmount = 0.4 ether;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: 0.4 ether}(coin, holders, balances); // less than its pots
        coin.quoteAmount = reserve + 0.5 ether;
        address token = mig.migrateToken{value: reserve + 0.5 ether}(coin, holders, balances);

        assertEq(pad.migrationPending(token), 0, "delivered whole");
        assertEq(IERC20(token).totalSupply(), pad.TOTAL_SUPPLY() - burnedThere, "the burn happened here too");
        assertEq(pad.burned(token), burnedThere);
        assertEq(IERC20(token).balanceOf(bob), sold - burnedThere);
        assertEq(_curve(token).realEth, reserve, "the reserve, the pots aside");
        assertEq(_curve(token).sold, sold);
        assertEq(pad.burnPot(token), 0.3 ether);
        assertEq(pad.liquidityPot(token), 0.2 ether);
        assertEq(_fees(token).sellTaxBps, 300);
        assertEq(_fees(token).platformBps, 50, "this launchpad's rate, whatever the ledger charged");
        assertTrue(pad.feesToHolders(token));

        // it trades taxed from the first block: a native buy, 0.5% + 3% off
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        pad.buy{value: 1 ether}(token, 0);
        assertEq(_curve(token).realEth, reserve + 0.965 ether);
        assertEq(treasury.balance, 0.005 ether, "the launchpad's half percent, in the native coin");
        assertEq(pad.creatorFees(alice, address(0)), 0.015 ether, "half the 3% tax to the creator");
        assertEq(pad.burnPot(token), 0.3 ether + 0.006 ether, "a fifth of it to the burn pot, on top of the ledger's");
        assertEq(pad.liquidityPot(token), 0.2 ether + 0.003 ether);
        // and its pot is there to spend
        assertGt(pad.buybackAndBurn(token), 0);
    }

    function test_aPooledLedgerCoinNobodyHoldsGraduatesAtBirth() public {
        // everyone sold into the pool there, or the coins were burned: nothing to deliver, so the pool is seeded at once
        mig.setMigrationRoot(bytes32(uint256(1)), 1);
        uint256 burnedThere = 10_000_000e18;
        LaunchpadBase.LedgerCoin memory coin = LaunchpadBase.LedgerCoin({
            name: "Empty Coin",
            symbol: "EMPT",
            meta: meta,
            creator: alice,
            feeRecipient: address(0),
            fees: custom,
            quoteAsset: address(0),
            quoteAmount: 5.1 ether,
            virtualQuote: 1.25 ether,
            sold: burnedThere,
            burned: burnedThere,
            poolToken: pad.TOTAL_SUPPLY() - burnedThere,
            burnPot: 0.1 ether,
            liquidityPot: 0
        });
        vm.deal(address(this), 5.1 ether);
        address token = mig.migrateToken{value: 5.1 ether}(coin, new address[](0), new uint256[](0));
        assertTrue(_curve(token).graduated, "graduated at birth");
        assertEq(pad.pendingCoins(), 0);
        assertGt(migrator.liquidity(token), 0, "its pool is seeded");
        address pair = migrator.pairOf(token);
        assertTrue(pad.taxedPool(token, pair), "and registered: taxed, no cashback");
        (uint256 rToken, uint256 rQuote) = _reserves(token);
        assertEq(rToken, pad.TOTAL_SUPPLY() - burnedThere);
        assertEq(rQuote, 5 ether, "the pool's quote side, the pot aside");
        assertEq(IERC20(token).totalSupply(), pad.TOTAL_SUPPLY() - burnedThere);
        assertEq(pad.eligibleSupply(token), 0, "nobody holds it: nothing is eligible");
        _assertEligible(token, pair);
        assertGt(pad.buybackAndBurn(token), 0, "and its pot is spent on that pool");
    }

    // --------------------------------------------------------------- the pool

    /// Graduation registers the pool the migrator seeded, and the seeding itself — the pad to the migrator,
    /// the migrator to the pair — pays nothing: the buckets are empty when trading opens.
    function test_graduationRegistersThePoolAndTaxesNothing() public {
        address token = _create(asym);
        quote.mint(bob, 200e8);
        vm.startPrank(bob);
        quote.approve(address(pad), 200e8);
        address pair = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory))); // the pair the factory makes next
        vm.expectEmit(true, true, false, false, address(pad));
        emit LaunchpadBase.PoolRegistered(token, pair);
        pad.buyWithQuote(token, 200e8, 0); // graduates: seeds, locks, registers
        vm.stopPrank();
        assertEq(migrator.pairOf(token), pair);
        assertTrue(pad.taxedPool(token, pair), "the pool the migrator seeded is registered at graduation");
        assertEq(address(pad.graduatedVia(token)), address(migrator));

        assertEq(pad.taxTreasury(token), 0, "nothing in the launchpad's bucket");
        assertEq(pad.taxPot(token), 0, "nor in the coin's");
        assertEq(IERC20(token).balanceOf(address(pad)), pad.lockedAtGraduation(token), "the pad holds the lock alone: no coins taxed");
        assertEq(IERC20(token).balanceOf(address(migrator)), 0, "nothing parked");
        _assertEligible(token, pair);

        // the rates: the launchpad's fee and the coin's tax on a leg the pool pays out (a buy) or is paid (a sell), nothing else
        assertEq(pad.transferRate(token, pair, carol), 250, "a buy: 0.5% + 2%");
        assertEq(pad.transferRate(token, carol, pair), 450, "a sell: 0.5% + 4%");
        assertEq(pad.transferRate(token, bob, carol), 0, "wallet to wallet");
        assertEq(pad.transferRate(token, address(pad), carol), 0, "the pad's own moves");
        assertEq(pad.transferRate(token, pair, address(pad)), 0, "...a buyback");
        assertEq(pad.transferRate(token, address(pad), address(migrator)), 0, "...a harvest's slice");
        assertEq(pad.transferRate(token, address(migrator), pair), 0, "the migrator's: seeding, selling the slice");
        assertEq(pad.transferRate(token, pair, address(migrator)), 0, "...unlocking");
        assertEq(pad.transferRate(token, carol, address(migrator)), 0);
        // a coin on its curve pays nothing in coins: its fees are taken in the quote
        address young = _create(asym);
        assertEq(pad.transferRate(young, pair, carol), 0);
        assertEq(pad.transferRate(young, carol, pair), 0);
    }

    function test_aPoolBuyPaysTheLaunchpadFeeAndTheBuyTax() public {
        (address token, address pair) = _graduate(asym);
        uint256 padBefore = IERC20(token).balanceOf(address(pad));
        uint256 treasuryBefore = quote.balanceOf(treasury); // the curve's fees: the pool's come later
        (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
        uint256 quoteIn = 1e8;
        uint256 out = _amountOut(quoteIn, rQuote, rToken);
        uint256 tax = (out * 250) / 10_000; // 0.5% + 2% of what the pool pays out
        {
            (uint256 out0, uint256 out1) = _outs(pair, token, out, true);
            quote.mint(carol, quoteIn);
            vm.startPrank(carol);
            quote.transfer(pair, quoteIn);
            vm.expectEmit(true, false, false, true, address(pad));
            emit LaunchpadBase.Taxed(token, true, tax);
            MockV2Pair(pair).swap(out0, out1, carol, "");
            vm.stopPrank();
        }

        assertEq(IERC20(token).balanceOf(carol), out - tax, "carol gets the net");
        assertEq(IERC20(token).balanceOf(address(pad)) - padBefore, tax, "the tax went to the pad, in coins");
        (uint256 platform, uint256 pot) = _split(tax, 250);
        assertGt(pot, 0);
        assertEq(pad.taxTreasury(token), platform, "the launchpad's part: the tax at platformBps over the rate");
        assertEq(pad.taxPot(token), pot, "the rest is the coin's");
        assertEq(platform, tax / 5, "a fifth of a 2.5% take is the 0.5%");
        {
            (uint256 rToken2, uint256 rQuote2) = _reservesOf(pair, token);
            assertEq(rToken2, rToken - out, "the pool paid the whole out: the tax came off carol's side");
            assertEq(rQuote2, rQuote + quoteIn);
        }
        assertEq(quote.balanceOf(treasury), treasuryBefore, "nothing in quote yet: the harvest sells the bucket");
        _assertEligible(token, pair);
    }

    function test_aPoolSellPaysTheLaunchpadFeeAndTheSellTax() public {
        (address token, address pair) = _graduate(asym);
        uint256 tokensIn = 1_000_000e18; // of bob's 800M
        uint256 tax = (tokensIn * 450) / 10_000; // 0.5% + 4% of what goes to the pool
        uint256 net = tokensIn - tax;
        (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
        uint256 quoteOut = _amountOut(net, rToken, rQuote); // the pool prices the net it got, not what bob sent
        uint256 padBefore = IERC20(token).balanceOf(address(pad));
        uint256 bobQuote = quote.balanceOf(bob);
        uint256 treasuryBefore = quote.balanceOf(treasury);

        vm.startPrank(bob);
        vm.expectEmit(true, false, false, true, address(pad));
        emit LaunchpadBase.Taxed(token, false, tax);
        IERC20(token).transfer(pair, tokensIn);
        assertEq(IERC20(token).balanceOf(pair), rToken + net, "the pair got the net");
        _swap(pair, token, quoteOut, false, bob);
        vm.stopPrank();

        assertEq(quote.balanceOf(bob) - bobQuote, quoteOut, "paid for the net");
        {
            (uint256 rToken2, uint256 rQuote2) = _reservesOf(pair, token);
            assertEq(rToken2, rToken + net, "the reserves, synced by the swap, hold the net");
            assertEq(rQuote2, rQuote - quoteOut);
        }
        assertEq(IERC20(token).balanceOf(address(pad)) - padBefore, tax);
        (uint256 platform, uint256 pot) = _split(tax, 450);
        assertEq(pad.taxTreasury(token), platform, "the launchpad's part");
        assertEq(pad.taxPot(token), pot, "the coin's");
        assertEq(platform, tax / 9, "a ninth of a 4.5% take is the 0.5%");
        // a pool trade feeds nothing in quote until the harvest: the treasury's quote stands still
        assertEq(quote.balanceOf(treasury), treasuryBefore);
        _assertEligible(token, pair);
    }

    /// The pad books only what a coin of its own took on a leg touching one of its pools.
    function test_onTaxBooksOnlyWhatACoinTookOnItsPool() public {
        (address token, address pair) = _graduate(asym);
        vm.expectRevert(LaunchpadBase.UnknownToken.selector);
        pad.onTax(pair, carol, 1); // not a coin of this pad
        vm.prank(token);
        vm.expectRevert(LaunchpadBase.BadHarvest.selector);
        pad.onTax(bob, carol, 1); // no pool on either side: the coin would not have taxed it
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), 0);
    }

    function test_walletToWalletPaysNothing() public {
        (address token, address pair) = _graduate(asym);
        _poolBuy(carol, token, pair, 1e8); // so the buckets hold something to compare against
        uint256 bucketT = pad.taxTreasury(token);
        uint256 bucketP = pad.taxPot(token);
        uint256 padBefore = IERC20(token).balanceOf(address(pad));
        uint256 carolBefore = IERC20(token).balanceOf(carol);
        uint256 amount = 1_000_000e18;

        vm.expectCall(address(pad), abi.encodeWithSelector(pad.onTax.selector), 0); // never asked to book a tax
        vm.prank(bob);
        IERC20(token).transfer(carol, amount);
        assertEq(IERC20(token).balanceOf(carol) - carolBefore, amount, "whole");
        assertEq(pad.taxTreasury(token), bucketT);
        assertEq(pad.taxPot(token), bucketP);
        assertEq(IERC20(token).balanceOf(address(pad)), padBefore);
        _assertEligible(token, pair);
    }

    /// The pad's and the migrator's own legs are exempt: a buyback takes the pool's output whole, a harvest's
    /// slice leaves the buckets and nothing of it comes back on the way to the pool.
    function test_legsTouchingThePadOrTheMigratorPayNothing() public {
        (address token, address pair) = _graduate(custom);
        _poolBuy(carol, token, pair, 2e8);
        uint256 buckets = pad.taxTreasury(token) + pad.taxPot(token);
        assertGt(pad.taxPot(token), 0);
        uint256 padBefore = IERC20(token).balanceOf(address(pad));

        // a buyback: the pool pays the pad, untaxed, and the whole output is burned
        {
            uint256 spend = Math.min(pad.burnPot(token), migrator.buybackCap(token));
            (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
            uint256 expectOut = _amountOut(spend, rQuote, rToken);
            uint256 supply = IERC20(token).totalSupply();
            vm.roll(block.number + 1);
            uint256 burned = pad.buybackAndBurn(token);
            assertEq(burned, expectOut, "the whole of what the pool paid out, no tax off it");
            assertEq(IERC20(token).totalSupply(), supply - burned);
        }
        assertEq(IERC20(token).balanceOf(address(pad)), padBefore, "came in whole, burned whole");
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), buckets, "the buckets untouched by a buyback");

        // a harvest: the pad hands the migrator a slice, the migrator sells it to the pool — neither leg taxed,
        // so the buckets drop by exactly the slice (the sale itself is Harvest.t.sol's business)
        vm.roll(block.number + 1);
        (uint256 tokensIn,,) = migrator.harvest(token);
        assertGt(tokensIn, 0);
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), buckets - tokensIn, "the slice left, nothing came back");
        assertEq(IERC20(token).balanceOf(address(migrator)), 0, "nothing stuck with the migrator");
        _assertEligible(token, pair);
    }

    /// Liquidity somebody else adds to a registered pool is a sell as far as the coin is concerned (the
    /// pool is paid): only the migrator's lock is exempt.
    function test_liquidityAddedByAThirdPartyIsTaxedAsASell() public {
        (address token, address pair) = _graduate(asym);
        (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
        uint256 lpTotal = MockV2Pair(pair).totalSupply();
        // bob adds a hundredth of the pool: the coins reach the pair net of the sell rate, the quote whole
        uint256 tokensIn = rToken / 100;
        uint256 tax = (tokensIn * 450) / 10_000;
        (uint256 platform, uint256 pot) = _split(tax, 450);
        uint256 lp = _addLiquidity(bob, token, pair, tokensIn, rQuote / 100);
        assertEq(lp, ((tokensIn - tax) * lpTotal) / rToken, "LP for the net coins: the taxed side is the scarcer one");
        {
            (uint256 rToken2, uint256 rQuote2) = _reservesOf(pair, token);
            assertEq(rToken2, rToken + tokensIn - tax, "the pool's coins grew by the net");
            assertEq(rQuote2, rQuote + rQuote / 100, "the quote whole: only the coin taxes");
        }
        assertEq(pad.taxTreasury(token), platform, "taxed as a sell: the launchpad's part");
        assertEq(pad.taxPot(token), pot, "and the coin's");
        _assertEligible(token, pair);
    }

    /// ...and taking it out again is a buy (the pool pays): the coins come back less the buy rate, the quote whole.
    function test_liquidityRemovedByAThirdPartyIsTaxedAsABuy() public {
        (address token, address pair) = _graduate(asym);
        uint256 lp;
        {
            (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
            lp = _addLiquidity(bob, token, pair, rToken / 100, rQuote / 100);
        }
        (uint256 outTokens, uint256 outQuote) = _shareOf(pair, token, lp);
        uint256 tax = (outTokens * 250) / 10_000;
        uint256 wantT;
        uint256 wantP;
        {
            (uint256 platform, uint256 pot) = _split(tax, 250);
            wantT = pad.taxTreasury(token) + platform;
            wantP = pad.taxPot(token) + pot;
        }
        uint256 bobTokens = IERC20(token).balanceOf(bob);
        uint256 bobQuote = quote.balanceOf(bob);

        (uint256 gotTokens, uint256 gotQuote) = _removeLiquidity(bob, token, pair, lp);
        assertEq(gotTokens, outTokens, "the pair paid out pro rata");
        assertEq(gotQuote, outQuote);
        assertEq(IERC20(token).balanceOf(bob) - bobTokens, outTokens - tax, "the coins back, less the buy rate");
        assertEq(quote.balanceOf(bob) - bobQuote, outQuote, "the quote whole");
        assertEq(pad.taxTreasury(token), wantT, "taxed as a buy: the launchpad's part");
        assertEq(pad.taxPot(token), wantP, "and the coin's");
        _assertEligible(token, pair);
    }

    /// What `lp` of the pair is worth, pro rata, as (coin, quote).
    function _shareOf(address pair, address token, uint256 lp) internal view returns (uint256 tokens, uint256 other) {
        (uint256 rToken, uint256 rOther) = _reservesOf(pair, token);
        uint256 ts = MockV2Pair(pair).totalSupply();
        return ((lp * rToken) / ts, (lp * rOther) / ts);
    }

    /// `who` redeems `lp` by hand, as the router would: the LP to the pair, then burn. Returns what the pair paid out, (coin, quote).
    function _removeLiquidity(address who, address token, address pair, uint256 lp)
        internal
        returns (uint256 gotTokens, uint256 gotQuote)
    {
        vm.startPrank(who);
        MockV2Pair(pair).transfer(pair, lp);
        (uint256 a0, uint256 a1) = MockV2Pair(pair).burn(who);
        vm.stopPrank();
        return MockV2Pair(pair).token0() == token ? (a0, a1) : (a1, a0);
    }

    /// `who` adds liquidity to the pair by hand, as the router would: both sides in, then mint.
    function _addLiquidity(address who, address token, address pair, uint256 tokensIn, uint256 quoteIn)
        internal
        returns (uint256 lp)
    {
        quote.mint(who, quoteIn);
        vm.startPrank(who);
        IERC20(token).transfer(pair, tokensIn);
        quote.transfer(pair, quoteIn);
        lp = MockV2Pair(pair).mint(who);
        vm.stopPrank();
    }

    function test_aTaxlessCoinPaysTheLaunchpadFeeAloneOnThePool() public {
        vm.prank(alice);
        address token = pad.createToken("Keep", "KEEP", 0, meta, address(quote), false);
        _buy(bob, token, 200e8); // graduates
        address pair = migrator.pairOf(token);
        assertTrue(pad.taxedPool(token, pair));
        assertEq(pad.transferRate(token, pair, carol), 50, "the 0.5% alone, on a buy");
        assertEq(pad.transferRate(token, carol, pair), 50, "and on a sell");

        uint256 out = _poolBuy(carol, token, pair, 1e8);
        uint256 tax = (out * 50) / 10_000;
        assertGt(tax, 0);
        assertEq(IERC20(token).balanceOf(carol), out - tax);
        assertEq(pad.taxTreasury(token), tax, "whole to the launchpad's bucket");
        assertEq(pad.taxPot(token), 0, "no tax, no shares");
        (uint256 net,) = _poolSell(bob, token, pair, 1_000_000e18);
        assertEq(net, 1_000_000e18 - 5_000e18, "half a percent off a sell");
        assertEq(pad.taxTreasury(token), tax + 5_000e18);
        assertEq(pad.taxPot(token), 0);
        _assertEligible(token, pair);
    }

    /// A coin created while the launchpad charged nothing, with no tax of its own, has nothing to take on
    /// its pool: the rate is 0, the coin never calls onTax, and nothing divides by that zero.
    function test_aCoinBornAtFeeZeroWithNoTaxIsNeverTaxedOnThePool() public {
        pad.setFeeBps(0);
        vm.prank(alice);
        address token = pad.createToken("Free", "FREE", 0, meta, address(quote), true);
        assertEq(_fees(token).platformBps, 0);
        _buy(bob, token, 200e8);
        address pair = migrator.pairOf(token);
        assertTrue(pad.taxedPool(token, pair), "registered all the same: no cashback on what it holds");
        assertEq(pad.transferRate(token, pair, carol), 0, "nothing to take");
        assertEq(pad.transferRate(token, carol, pair), 0);

        // were the coin ever to ask with nothing to book, the pad refuses rather than dividing by zero
        vm.prank(token);
        vm.expectRevert(LaunchpadBase.BadHarvest.selector);
        pad.onTax(pair, carol, 1);

        vm.expectCall(address(pad), abi.encodeWithSelector(pad.onTax.selector), 0); // never asked from here on
        uint256 out = _poolBuy(carol, token, pair, 1e8);
        assertEq(IERC20(token).balanceOf(carol), out, "whole");
        (uint256 net,) = _poolSell(bob, token, pair, 1_000_000e18);
        assertEq(net, 1_000_000e18, "whole");
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), 0);
        assertEq(IERC20(token).balanceOf(address(pad)), pad.lockedAtGraduation(token));
        _assertEligible(token, pair);
    }

    /// The pool, the pad and the migrator hold no cashback: what everyone else holds is the eligible supply,
    /// kept in sync by every pool trade, and the holders' share of a harvest is spread over that alone.
    function test_thePoolHoldsNoCashback() public {
        (address token, address pair) = _graduate(asym);
        _assertEligible(token, pair);
        uint256 eligible = pad.eligibleSupply(token);
        assertEq(eligible, IERC20(token).balanceOf(bob), "right after graduation: bob's curve supply alone");

        // a pool buy: the buyer's net joins the eligible supply (the tax went to the pad: not eligible)
        _poolBuy(carol, token, pair, 1e8);
        uint256 got = IERC20(token).balanceOf(carol);
        assertEq(pad.eligibleSupply(token), eligible + got, "the net, not the gross");
        _assertEligible(token, pair);
        // a sell: everything the seller sent leaves it — the net to the pool, the tax to the pad
        uint256 tokensIn = 1_000_000e18;
        _poolSell(bob, token, pair, tokensIn);
        assertEq(pad.eligibleSupply(token), eligible + got - tokensIn);
        _assertEligible(token, pair);

        // the holders' share the harvest brings back (poolFee, called here as the migrator would) is spread
        // over that supply alone: bob and carol get the whole of it, the pool none
        uint256 toHolders = 1e8;
        quote.mint(address(pad), toHolders);
        uint256 bobBefore = pad.cashbackOf(token, bob);
        vm.prank(address(migrator));
        pad.poolFee(token, 0, 0, toHolders, 0);
        uint256 supply = pad.eligibleSupply(token);
        assertApproxEqAbs(pad.cashbackOf(token, bob) - bobBefore, (toHolders * IERC20(token).balanceOf(bob)) / supply, 2);
        assertApproxEqAbs(pad.cashbackOf(token, carol), (toHolders * got) / supply, 2);
        assertApproxEqAbs(pad.cashbackOf(token, bob) - bobBefore + pad.cashbackOf(token, carol), toHolders, 2, "whole to the holders");
    }

    /// A registered pool earns no cashback of its own either: the holders' share is spread over the eligible
    /// supply alone, so a claim by the pool — its balance times the accumulator since it was registered —
    /// would be paid out of the holders' money. The pad, the pool and the migrator must read, and claim, zero.
    function test_thePoolClaimsNoCashback() public {
        (address token, address pair) = _graduate(asym);
        _poolBuy(carol, token, pair, 1e8);
        uint256 toHolders = 1e8;
        uint256 before = pad.cashbackOf(token, bob) + pad.cashbackOf(token, carol); // the curve's, from bob's graduating buy
        quote.mint(address(pad), toHolders);
        vm.prank(address(migrator));
        pad.poolFee(token, 0, 0, toHolders, 0);
        assertApproxEqAbs(pad.cashbackOf(token, bob) + pad.cashbackOf(token, carol) - before, toHolders, 2, "whole to the holders");
        assertEq(pad.cashbackOf(token, pair), 0, "the pool earns nothing");
        assertEq(pad.cashbackOf(token, address(migrator)), 0, "nor the migrator");
        assertEq(pad.cashbackOf(token, address(pad)), 0, "nor the pad");
        vm.prank(pair);
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        pad.claimCashback(token); // nothing to claim: the holders' money is the holders'
    }

    /// The quote a harvest realises is booked as a curve fee's would be: the treasury paid at once, the
    /// creator's share (or the fee recipient's) and the holders' to claim, the burn-pot share for buybackAndBurn.
    function test_poolFeeBooksTheQuoteLikeACurveFee() public {
        (address token,) = _graduate(asym);
        uint256 treasuryBefore = quote.balanceOf(treasury);
        uint256 creatorBefore = pad.creatorFees(alice, address(quote));
        uint256 burnBefore = pad.burnPot(token);
        uint256 bobBefore = pad.cashbackOf(token, bob);
        // the migrator hands the quote over first, then says what it is for
        quote.mint(address(pad), 10e8);
        vm.deal(address(migrator), 1);
        vm.startPrank(address(migrator));
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        pad.poolFee{value: 1}(token, 4e8, 3e8, 2e8, 1e8); // no value with an ERC-20 quote
        vm.expectEmit(true, false, false, true, address(pad));
        emit LaunchpadBase.PoolFee(token, 4e8, 3e8, 2e8, 1e8);
        pad.poolFee(token, 4e8, 3e8, 2e8, 1e8);
        vm.stopPrank();
        assertEq(quote.balanceOf(treasury) - treasuryBefore, 4e8, "the treasury is paid at once");
        assertEq(pad.creatorFees(alice, address(quote)) - creatorBefore, 3e8, "the creator's, to claim");
        assertEq(pad.burnPot(token) - burnBefore, 1e8, "the burn pot, for buybackAndBurn");
        assertApproxEqAbs(pad.cashbackOf(token, bob) - bobBefore, 2e8, 2, "the holders': bob alone holds");

        // the creator's share follows the fee recipient, as on the curve
        vm.prank(alice);
        pad.setFeeRecipient(token, cold);
        quote.mint(address(pad), 1e8);
        vm.prank(address(migrator));
        pad.poolFee(token, 0, 1e8, 0, 0);
        assertEq(pad.creatorFees(cold, address(quote)), 1e8);
        assertEq(pad.creatorFees(alice, address(quote)) - creatorBefore, 3e8, "no more for the creator herself");
    }

    /// Another pool of a graduated coin is the owner's to register — a pool, not a wallet — and from then on
    /// it is taxed like the first and what it holds earns no cashback.
    function test_registerTaxedPoolIsTheOwnersAndWantsAPoolOfTheCoin() public {
        (address token, address pair) = _graduate(asym);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bob));
        pad.registerTaxedPool(token, pair);
        address young = _create(asym);
        vm.expectRevert(LaunchpadBase.NotYetGraduated.selector);
        pad.registerTaxedPool(young, pair); // a coin on its curve has no pool
        vm.expectRevert(LaunchpadBase.BadPool.selector);
        pad.registerTaxedPool(token, bob); // a wallet
        address otherPair = factory.createPair(address(quote), address(weth));
        vm.expectRevert(LaunchpadBase.BadPool.selector);
        pad.registerTaxedPool(token, otherPair); // a pool of two other assets

        // a second pool of the coin, against another asset, seeded by bob: untaxed and eligible until registered
        address pair2 = factory.createPair(token, address(weth));
        uint256 seedT = 10_000_000e18;
        vm.deal(bob, 1 ether);
        vm.startPrank(bob);
        weth.deposit{value: 1 ether}();
        IERC20(token).transfer(pair2, seedT); // a wallet to a contract nobody registered: nothing taken
        weth.transfer(pair2, 1 ether);
        MockV2Pair(pair2).mint(bob);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(pair2), seedT, "whole: not a registered pool yet");
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), 0);
        assertEq(pad.transferRate(token, pair2, carol), 0);
        uint256 eligible = pad.eligibleSupply(token);

        vm.expectEmit(true, true, false, false, address(pad));
        emit LaunchpadBase.PoolRegistered(token, pair2);
        pad.registerTaxedPool(token, pair2);
        assertTrue(pad.taxedPool(token, pair2));
        assertTrue(pad.taxedPool(token, pair), "the first one still");
        assertEq(pad.eligibleSupply(token), eligible - seedT, "what the pool holds earns no cashback from now on");
        assertEq(pad.transferRate(token, pair2, carol), 250);
        assertEq(pad.transferRate(token, carol, pair2), 450);
        _assertTaxedBuyOnTheWethPool(token, pair2);
        assertEq(
            pad.eligibleSupply(token),
            IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad)) - IERC20(token).balanceOf(pair)
                - IERC20(token).balanceOf(pair2) - IERC20(token).balanceOf(address(migrator)),
            "the invariant, both pools out"
        );

        // registering a pool twice changes nothing: not taken off the supply again, no event
        uint256 once = pad.eligibleSupply(token);
        vm.recordLogs();
        pad.registerTaxedPool(token, pair2);
        pad.registerTaxedPool(token, pair);
        assertEq(vm.getRecordedLogs().length, 0, "a no-op");
        assertEq(pad.eligibleSupply(token), once);
    }

    /// A buy on the coin's WETH pool pays the buy rate like one on its cbLTC pool.
    function _assertTaxedBuyOnTheWethPool(address token, address pair2) internal {
        (uint256 rToken, uint256 rWeth) = _reservesOf(pair2, token);
        uint256 out = _amountOut(0.01 ether, rWeth, rToken);
        uint256 tax = (out * 250) / 10_000;
        (uint256 platform, uint256 pot) = _split(tax, 250);
        (uint256 out0, uint256 out1) = _outs(pair2, token, out, true);
        vm.deal(carol, 0.01 ether);
        vm.startPrank(carol);
        weth.deposit{value: 0.01 ether}();
        weth.transfer(pair2, 0.01 ether);
        vm.expectEmit(true, false, false, true, address(pad));
        emit LaunchpadBase.Taxed(token, true, tax);
        MockV2Pair(pair2).swap(out0, out1, carol, "");
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(carol), out - tax, "taxed like a buy on the first pool");
        assertEq(pad.taxTreasury(token), platform);
        assertEq(pad.taxPot(token), pot);
    }

    /// Only the migrator that seeded a coin's pool may take its buckets or hand quote back for it: not a
    /// wallet, not the owner, not another migrator, and nobody at all for a coin still on its curve.
    function test_takeTaxAndPoolFeeAreTheMigratorsAlone() public {
        (address token, address pair) = _graduate(asym);
        address young = _create(asym);
        UniV2Migrator other = new UniV2Migrator(address(pad), address(migrator.router()));
        address[3] memory callers = [bob, address(this), address(other)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(LaunchpadBase.NotMigrator.selector);
            pad.takeTax(token, 0, 0, 0);
            vm.expectRevert(LaunchpadBase.NotMigrator.selector);
            pad.poolFee(token, 0, 0, 0, 0);
            vm.expectRevert(LaunchpadBase.NotMigrator.selector);
            pad.takeTax(young, 0, 0, 0);
            vm.expectRevert(LaunchpadBase.NotMigrator.selector);
            pad.poolFee(young, 0, 0, 0, 0);
            vm.stopPrank();
        }

        // the coin's own migrator may, within the buckets: the burn share is burned here, the rest handed over
        _poolBuy(carol, token, pair, 1e8);
        uint256 bucketT = pad.taxTreasury(token);
        uint256 bucketP = pad.taxPot(token);
        uint256 supply = IERC20(token).totalSupply();
        vm.startPrank(address(migrator));
        vm.expectRevert(stdError.arithmeticError);
        pad.takeTax(token, bucketT + 1, 0, 0); // more than the launchpad's bucket holds
        vm.expectRevert(stdError.arithmeticError);
        pad.takeTax(token, 0, bucketP + 1, 0); // more than the coin's
        vm.expectRevert(LaunchpadBase.BadHarvest.selector);
        pad.takeTax(token, 0, bucketP / 2, bucketP / 2 + 1); // burning more than the coin's part taken
        uint256 toSell = pad.takeTax(token, bucketT, bucketP / 2, bucketP / 4);
        vm.stopPrank();
        assertEq(toSell, bucketT + bucketP / 2 - bucketP / 4, "what is left to sell");
        assertEq(pad.taxTreasury(token), 0);
        assertEq(pad.taxPot(token), bucketP - bucketP / 2, "the rest waits");
        assertEq(pad.burned(token), bucketP / 4, "the burn share burned here, no sale needed");
        assertEq(IERC20(token).totalSupply(), supply - bucketP / 4);
        assertEq(IERC20(token).balanceOf(address(migrator)), toSell, "handed over whole: the pad's leg is untaxed");
        _assertEligible(token, pair);

        // and not while the launchpad stands still
        mig.announceFreeze(block.number);
        vm.prank(address(migrator));
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.takeTax(token, 0, 1, 0);
    }
}
