// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";

/// The harvest: a graduated coin's pool trades leave the launchpad's fee and
/// the coin's tax with the launchpad in coins (taxTreasury, taxPot); anyone
/// may have the coin's migrator sell a slice of them on the pool and bring
/// the quote back for the same four shares the curve pays — the burn share
/// burned instead of sold, the liquidity share added to the locked pool —
/// a slice a block, half a percent of the pool at most, except in the rush
/// before a freeze. Every figure here is the arithmetic of §5 of the design,
/// replayed from the launchpad's and the pool's state before the call.
contract HarvestTest is Test {
    Launchpad pad;
    ILaunchpadMigration mig;
    UniV2Migrator migrator;
    MockWETH9 weth;
    MockV2Factory factory;
    MockCbLTC cb;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates every coin
    address bob = makeAddr("bob"); //     buys every curve out: the big holder
    address carol = makeAddr("carol"); // trades on the pool
    address dave = makeAddr("dave"); //   harvests: no role, any EOA
    address eve = makeAddr("eve"); //     sandwiches
    LaunchpadBase.TokenMetadata meta = LaunchpadBase.TokenMetadata("", "", "", "", "", "");
    /// 3% each way; the pot half to the creator, a fifth to holders, a fifth burned, a tenth to liquidity
    LaunchpadBase.FeeConfig custom = LaunchpadBase.FeeConfig(300, 300, 5000, 2000, 2000, 1000, 0);
    /// 1% each way, the pot half creator half holders: every coin taken is sold, so the split compares with the curve's in quote
    LaunchpadBase.FeeConfig onePercent = LaunchpadBase.FeeConfig(100, 100, 5000, 5000, 0, 0, 0);

    /// One harvest as §5 computes it from the state before the call.
    struct Exp {
        uint256 tT; //        taxTreasury before
        uint256 tP; //        taxPot before
        uint256 slice; //     min(total, cap), or the whole in a rush
        uint256 sT; //        of it, the launchpad's (pro rata)
        uint256 sP; //        and the coin's
        uint256 burnT;
        uint256 liqT;
        uint256 creatorT;
        uint256 holdersT;
        uint256 deepenT; //   the half of the liquidity share kept as coins (0: the pool would mint nothing)
        bool doDeepen;
        uint256 sellT;
        uint256 quoteOut;
        uint256 qT; //        the treasury's quote, the tip already off
        uint256 qC;
        uint256 qH;
        uint256 qL;
        uint256 tip;
        uint256 lp;
        uint256 toBurnPot;
        uint256 rToken;
        uint256 rQuote;
    }

    /// What the balances were before a harvest.
    struct Snap {
        uint256 supply;
        uint256 burned;
        uint256 padTokens;
        uint256 treasuryQ;
        uint256 callerQ;
        uint256 padQ;
        uint256 creatorQ;
        uint256 burnPot;
        uint256 acc;
        uint256 lp;
        uint256 bobCashback;
        uint256 carolCashback;
        uint256 pairCashback;
        uint256 migratorCashback;
    }

    function setUp() public {
        pad = new Launchpad(treasury);
        mig = ILaunchpadMigration(address(pad));
        cb = new MockCbLTC();
        pad.setQuoteAsset(address(cb), 30e8); // as on Base; the native quote stays on (1.25 ether)
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        pad.setMigrator(address(migrator));
        vm.deal(bob, 1000 ether);
        vm.deal(carol, 1000 ether);
        vm.deal(eve, 1000 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _create(address quoteAsset, LaunchpadBase.FeeConfig memory fees) internal returns (address) {
        vm.prank(alice);
        return pad.createTokenWithFees("Taxed Coin", "TAX", 0, meta, quoteAsset, fees);
    }

    function _isNative(address token) internal view returns (bool) {
        return migrator.nativeQuote(token);
    }

    /// The asset the pad books and pays in: address(0) for a native curve.
    function _padAsset(address token) internal view returns (address) {
        (,,,,,, address q) = pad.curves(token);
        return q;
    }

    /// What `who` holds of the coin's quote as the pad pays it: the chain's coin, or the ERC-20.
    function _padQuote(address token, address who) internal view returns (uint256) {
        return _isNative(token) ? who.balance : cb.balanceOf(who);
    }

    function _fees(address token) internal view returns (LaunchpadBase.FeeConfig memory f) {
        (f.buyTaxBps, f.sellTaxBps, f.creatorBps, f.holdersBps, f.burnBps, f.liquidityBps, f.platformBps) =
            pad.feeConfig(token);
    }

    function _curveBuy(address who, address token, uint256 amount) internal {
        if (_padAsset(token) == address(0)) {
            vm.prank(who);
            pad.buy{value: amount}(token, 0);
        } else {
            cb.mint(who, amount);
            vm.startPrank(who);
            cb.approve(address(pad), amount);
            pad.buyWithQuote(token, amount, 0);
            vm.stopPrank();
        }
    }

    /// Bob buys the curve out: it graduates and its pool is seeded in the same call.
    function _graduate(address token) internal {
        _curveBuy(bob, token, _padAsset(token) == address(0) ? 10 ether : 200e8);
        (,,,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertGt(migrator.liquidity(token), 0, "the pool is seeded");
        assertTrue(pad.taxedPool(token, migrator.pairOf(token)), "and registered: taxed, no cashback");
    }

    /// Give `who` `amount` of the asset the pool trades in: WETH for a native curve, the ERC-20 otherwise.
    function _fund(address who, address token, uint256 amount) internal {
        if (_isNative(token)) {
            vm.deal(who, who.balance + amount);
            vm.prank(who);
            weth.deposit{value: amount}();
        } else {
            cb.mint(who, amount);
        }
    }

    function _reserves(address token) internal view returns (uint256 rToken, uint256 rQuote) {
        MockV2Pair pair = MockV2Pair(migrator.pairOf(token));
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rToken, rQuote) = pair.token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Uniswap v2's getAmountOut.
    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    /// A buy on the pool, as a router does it: the quote to the pair, the coins out to `who`.
    /// The pair pays out the gross; the coin keeps the tax with the pad on the way.
    function _poolBuy(address who, address token, uint256 quoteIn) internal returns (uint256 gross, uint256 net) {
        MockV2Pair pair = MockV2Pair(migrator.pairOf(token));
        (uint256 rToken, uint256 rQuote) = _reserves(token);
        gross = _amountOut(quoteIn, rQuote, rToken);
        uint256 before = IERC20(token).balanceOf(who);
        vm.startPrank(who);
        IERC20(migrator.pairAsset(token)).transfer(address(pair), quoteIn);
        (uint256 o0, uint256 o1) = pair.token0() == token ? (gross, uint256(0)) : (uint256(0), gross);
        pair.swap(o0, o1, who, "");
        vm.stopPrank();
        net = IERC20(token).balanceOf(who) - before;
    }

    /// A sell on the pool: the coins to the pair (the tax comes off on the way, so the pair
    /// receives less than was sent), the quote for what arrived out to `who`.
    function _poolSell(address who, address token, uint256 tokensIn) internal returns (uint256 quoteOut) {
        MockV2Pair pair = MockV2Pair(migrator.pairOf(token));
        (uint256 rToken, uint256 rQuote) = _reserves(token);
        vm.startPrank(who);
        IERC20(token).transfer(address(pair), tokensIn);
        uint256 arrived = IERC20(token).balanceOf(address(pair)) - rToken;
        quoteOut = _amountOut(arrived, rToken, rQuote);
        (uint256 o0, uint256 o1) = pair.token0() == token ? (uint256(0), quoteOut) : (quoteOut, uint256(0));
        pair.swap(o0, o1, who, "");
        vm.stopPrank();
    }

    /// Carol trades the pool enough that the buckets hold more than one slice.
    function _fillBuckets(address token) internal {
        uint256 quoteIn = _isNative(token) ? 2 ether : 50e8;
        for (uint256 i = 0; i < 2; i++) {
            _fund(carol, token, quoteIn);
            _poolBuy(carol, token, quoteIn);
            _poolSell(carol, token, IERC20(token).balanceOf(carol));
        }
        assertGt(pad.taxTreasury(token) + pad.taxPot(token), migrator.harvestCap(token), "more than a slice waits");
    }

    /// §5, step by step, from the state before the call.
    function _expected(address token, bool rush) internal view returns (Exp memory e) {
        e.tT = pad.taxTreasury(token);
        e.tP = pad.taxPot(token);
        uint256 total = e.tT + e.tP;
        e.slice = total;
        if (!rush) {
            uint256 cap = migrator.harvestCap(token);
            if (e.slice > cap) e.slice = cap;
        }
        e.sT = (e.slice * e.tT) / total;
        e.sP = e.slice - e.sT;
        LaunchpadBase.FeeConfig memory f = _fees(token);
        e.burnT = (e.sP * f.burnBps) / 10_000;
        e.liqT = (e.sP * f.liquidityBps) / 10_000;
        e.creatorT = (e.sP * f.creatorBps) / 10_000;
        e.holdersT = e.sP - e.burnT - e.liqT - e.creatorT;
        (e.rToken, e.rQuote) = _reserves(token);
        uint256 lpTotal = MockV2Pair(migrator.pairOf(token)).totalSupply();
        e.deepenT = e.liqT / 2;
        if (e.deepenT != 0) {
            uint256 qEst = _amountOut(e.liqT - e.deepenT, e.rToken, e.rQuote);
            e.doDeepen = (e.deepenT * lpTotal) / e.rToken != 0 && (qEst * lpTotal) / e.rQuote != 0;
            if (!e.doDeepen) e.deepenT = 0;
        }
        e.sellT = e.slice - e.burnT - e.deepenT;
        e.quoteOut = _amountOut(e.sellT, e.rToken, e.rQuote);
        e.qT = (e.quoteOut * e.sT) / e.sellT;
        e.qC = (e.quoteOut * e.creatorT) / e.sellT;
        e.qH = (e.quoteOut * e.holdersT) / e.sellT;
        e.qL = (e.quoteOut * (e.liqT - e.deepenT)) / e.sellT;
        e.qT += e.quoteOut - e.qT - e.qC - e.qH - e.qL; // dust to the treasury
        e.tip = e.qT / migrator.TIP_DIVISOR();
        e.qT -= e.tip;
        if (e.doDeepen) {
            // the pair mints against the reserves the sale left, the scarcer side deciding
            uint256 rT = e.rToken + e.sellT;
            uint256 rQ = e.rQuote - e.quoteOut;
            e.lp = Math.min((e.deepenT * lpTotal) / rT, (e.qL * lpTotal) / rQ);
        } else {
            e.toBurnPot = e.qL;
        }
    }

    function _snap(address token, address caller) internal view returns (Snap memory s) {
        address pair = migrator.pairOf(token);
        s.supply = IERC20(token).totalSupply();
        s.burned = pad.burned(token);
        s.padTokens = IERC20(token).balanceOf(address(pad));
        s.treasuryQ = _padQuote(token, treasury);
        s.callerQ = _padQuote(token, caller);
        s.padQ = _padQuote(token, address(pad));
        s.creatorQ = pad.creatorFees(alice, _padAsset(token));
        s.burnPot = pad.burnPot(token);
        s.acc = pad.accCashbackPerShare(token);
        s.lp = migrator.liquidity(token);
        s.bobCashback = pad.cashbackOf(token, bob);
        s.carolCashback = pad.cashbackOf(token, carol);
        s.pairCashback = pad.cashbackOf(token, pair);
        s.migratorCashback = pad.cashbackOf(token, address(migrator));
    }

    /// One harvest by `caller`, its events and its return values against `e`.
    function _harvest(address token, Exp memory e, address caller) internal {
        vm.expectEmit(true, false, false, true);
        emit LaunchpadBase.PoolFee(token, e.qT, e.qC, e.qH, e.toBurnPot);
        vm.expectEmit(true, true, false, true);
        emit UniV2Migrator.Harvested(token, migrator.pairOf(token), e.slice, e.quoteOut, e.burnT, e.lp, caller, e.tip);
        vm.prank(caller);
        (uint256 tokensIn, uint256 quoteOut, uint256 tokensBurned) = migrator.harvest(token);
        assertEq(tokensIn, e.slice, "coins taken");
        assertEq(quoteOut, e.quoteOut, "quote realised");
        assertEq(tokensBurned, e.burnT, "coins burned");
    }

    /// Everything a harvest leaves behind, against §5.
    function _check(address token, Exp memory e, Snap memory s, address caller) internal view {
        address pair = migrator.pairOf(token);
        // the slice, pro rata across the two buckets
        assertEq(pad.taxTreasury(token), e.tT - e.sT, "the launchpad's bucket gave its pro rata part");
        assertEq(pad.taxPot(token), e.tP - e.sP, "the coin's bucket the rest");
        assertEq(e.sT, (e.slice * e.tT) / (e.tT + e.tP));
        // the burn share: burned, never sold
        assertEq(IERC20(token).totalSupply(), s.supply - e.burnT, "the burn share is gone from the supply");
        assertEq(pad.burned(token), s.burned + e.burnT, "and counted");
        assertEq(IERC20(token).balanceOf(address(pad)), s.padTokens - e.slice, "the slice left the pad, burned or sold");
        assertEq(
            IERC20(token).balanceOf(address(pad)),
            pad.lockedAtGraduation(token) + pad.taxTreasury(token) + pad.taxPot(token),
            "the pad holds the lock and the buckets, nothing else"
        );
        // the liquidity share: deepened, or sold for the burn pot
        if (e.doDeepen) {
            assertGt(e.lp, 0);
            assertEq(migrator.liquidity(token), s.lp + e.lp, "the locked position deepened");
            assertEq(pad.burnPot(token), s.burnPot, "nothing to the burn pot");
        } else {
            assertEq(e.lp, 0);
            assertEq(migrator.liquidity(token), s.lp, "nothing minted");
            assertEq(pad.burnPot(token), s.burnPot + e.qL, "the share's quote waits for a buyback");
        }
        assertEq(MockV2Pair(pair).balanceOf(address(migrator)), migrator.liquidity(token), "the LP is the migrator's");
        // the quote: the treasury's part less the tip, the tip to the caller, creator and holders booked
        assertEq(_padQuote(token, treasury) - s.treasuryQ, e.qT, "the treasury: its part, the tip off");
        assertEq(_padQuote(token, caller) - s.callerQ, e.tip, "the caller: a twentieth of the treasury's part");
        assertEq(e.tip, (e.qT + e.tip) / 20);
        assertEq(pad.creatorFees(alice, _padAsset(token)) - s.creatorQ, e.qC, "the creator's share is claimable");
        assertEq(
            pad.accCashbackPerShare(token) - s.acc,
            (e.qH * 1e30) / pad.eligibleSupply(token),
            "the holders' share moved the accumulator"
        );
        assertEq(_padQuote(token, address(pad)) - s.padQ, e.qC + e.qH + e.toBurnPot, "the pad got what it books");
        // nothing stranded
        assertEq(IERC20(migrator.pairAsset(token)).balanceOf(address(migrator)), 0, "no quote left in the migrator");
        assertEq(address(migrator).balance, 0, "no coin of the chain either");
        assertEq(IERC20(token).balanceOf(address(migrator)), 0, "and no coins");
        // the holders' share reached the holders, pro rata
        uint256 eligible = pad.eligibleSupply(token);
        assertApproxEqAbs(
            pad.cashbackOf(token, bob) - s.bobCashback, (IERC20(token).balanceOf(bob) * e.qH) / eligible, 1, "bob's cashback"
        );
        assertApproxEqAbs(
            pad.cashbackOf(token, carol) - s.carolCashback,
            (IERC20(token).balanceOf(carol) * e.qH) / eligible,
            1,
            "carol's cashback"
        );
        // the pad holds exactly what the creator, the holders and the burn pot are owed (rounding dust aside)
        uint256 owed = pad.creatorFees(alice, _padAsset(token)) + pad.burnPot(token) + pad.liquidityPot(token)
            + pad.cashbackOf(token, bob) + pad.cashbackOf(token, carol) + pad.cashbackOf(token, eve);
        assertApproxEqAbs(_padQuote(token, address(pad)), owed, 4, "the pad's quote is what it owes");
        assertEq(
            eligible,
            IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad)) - IERC20(token).balanceOf(pair)
                - IERC20(token).balanceOf(address(migrator)),
            "eligible supply: everyone but the pad, the pool and the migrator"
        );
    }

    /// A pool buy and a sell by carol, then one harvest that takes the buckets whole, checked to the unit.
    function _oneFullHarvest(address token) internal {
        _graduate(token);
        uint256 quoteIn = _isNative(token) ? 0.1 ether : 2e8;
        _fund(carol, token, quoteIn);
        _poolBuy(carol, token, quoteIn);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        assertGt(pad.taxTreasury(token), 0, "the launchpad's bucket filled");
        assertGt(pad.taxPot(token), 0, "the coin's too");

        Exp memory e = _expected(token, false);
        assertEq(e.slice, e.tT + e.tP, "the buckets fit under the cap: taken whole");
        assertTrue(e.doDeepen, "the liquidity share is big enough to mint on both sides");
        assertGt(e.burnT, 0);
        assertGt(e.tip, 0);
        Snap memory s = _snap(token, dave);
        _harvest(token, e, dave);
        _check(token, e, s, dave);
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), 0, "the buckets are empty");
    }

    // ------------------------------------------------------------- the split

    /// ERC-20 quote (cbLTC): the quote reaches the pad by a transfer before poolFee.
    function test_harvestSplitsTheSliceAsConfigured_erc20Quote() public {
        _oneFullHarvest(_create(address(cb), custom));
    }

    /// Native quote: the pool holds WETH, the migrator unwraps, poolFee is paid as value, the tip is the chain's coin.
    function test_harvestSplitsTheSliceAsConfigured_nativeQuote() public {
        _oneFullHarvest(_create(address(0), custom));
    }

    /// The pot part is split in coins by the coin's FeeConfig before anything is sold: the
    /// burn share never touches the pool, the quote goes to each share pro rata to what it sold.
    function test_theSharesAreCutInCoinsAndPaidProRataInQuote() public {
        address token = _create(address(cb), custom);
        _graduate(token);
        _fund(carol, token, 3e8);
        (uint256 gross,) = _poolBuy(carol, token, 3e8);
        Exp memory e = _expected(token, false);
        // the buckets hold what the buy taxed, the launchpad's part by its rate: 50 of 350
        uint256 taxed = (gross * 350) / 10_000;
        assertEq(e.tT, (taxed * 50) / 350, "the launchpad's bucket");
        assertEq(e.tP, taxed - (taxed * 50) / 350, "the coin's bucket");
        assertEq(e.sT, e.tT, "taken whole: under the cap");
        assertEq(e.sP, e.tP);
        assertEq(e.burnT, (e.sP * 2000) / 10_000, "a fifth burned");
        assertEq(e.liqT, (e.sP * 1000) / 10_000, "a tenth to liquidity");
        assertEq(e.creatorT, (e.sP * 5000) / 10_000, "half to the creator");
        assertEq(e.holdersT, e.sP - e.burnT - e.liqT - e.creatorT, "a fifth to holders, rounding included");
        assertEq(e.sellT, e.slice - e.burnT - e.liqT / 2, "sold: everything but the burn share and the kept half");
        // each share's quote is its coins' part of the sale; the treasury gets the dust
        assertEq(e.qC, (e.quoteOut * e.creatorT) / e.sellT);
        assertEq(e.qH, (e.quoteOut * e.holdersT) / e.sellT);
        assertEq(e.qL, (e.quoteOut * (e.liqT - e.liqT / 2)) / e.sellT);
        assertEq(e.qT + e.tip, e.quoteOut - e.qC - e.qH - e.qL);
        assertGe(e.qT + e.tip, (e.quoteOut * e.sT) / e.sellT);
        assertLe(e.qT + e.tip, (e.quoteOut * e.sT) / e.sellT + 4);
        Snap memory s = _snap(token, dave);
        _harvest(token, e, dave);
        _check(token, e, s, dave);
    }

    /// Where one trade's fee went: the treasury's (a caller's tip counted as the treasury's part),
    /// the creator's, and the holders' as the accumulator paid it over the eligible supply.
    struct Split {
        uint256 treasury;
        uint256 creator;
        uint256 holders;
    }

    function _mark(address token) internal view returns (Split memory m) {
        m.treasury = cb.balanceOf(treasury);
        m.creator = pad.creatorFees(alice, address(cb));
        m.holders = pad.accCashbackPerShare(token);
    }

    function _since(address token, Split memory m, address tipped) internal view returns (Split memory d) {
        d.treasury = cb.balanceOf(treasury) - m.treasury + (tipped == address(0) ? 0 : cb.balanceOf(tipped));
        d.creator = pad.creatorFees(alice, address(cb)) - m.creator;
        d.holders = ((pad.accCashbackPerShare(token) - m.holders) * pad.eligibleSupply(token)) / 1e30;
    }

    /// A trade on the pool at the coin's rate pays the same as the same trade on the curve: the
    /// launchpad's part, the creator's and the holders' in the same proportions, and about the
    /// same quote — less only the sale's slippage and Uniswap's 0.3%.
    function test_theCurveAndThePoolSplitTheSameRateAlike() public {
        address token = _create(address(cb), onePercent);
        _curveBuy(bob, token, 10e8); // a holder first, so the holders' share has somewhere to go
        uint256 amount = 1e8;

        // the curve: 1.5% of the trade, a third of it the launchpad's, the rest half creator half holders
        Split memory m = _mark(token);
        _curveBuy(carol, token, amount);
        Split memory curve = _since(token, m, address(0));
        uint256 fee = (amount * 150) / 10_000;
        assertEq(curve.treasury, (fee * 50) / 150, "the launchpad's 0.5%");
        assertEq(curve.creator, ((fee - (fee * 50) / 150) * 5000) / 10_000, "half the tax to the creator");
        assertApproxEqAbs(curve.holders, curve.creator, 1, "half to holders");

        // the pool: the same amount, the tax in coins at the same rate, sold by a harvest
        _graduate(token);
        _fund(carol, token, amount);
        (uint256 gross,) = _poolBuy(carol, token, amount);
        uint256 taxed = (gross * 150) / 10_000;
        assertEq(pad.taxTreasury(token), (taxed * 50) / 150, "a third the launchpad's");
        assertEq(pad.taxPot(token), taxed - (taxed * 50) / 150, "two thirds the coin's");
        Exp memory e = _expected(token, false);
        assertEq(e.slice, taxed, "the whole tax fits under the cap");
        assertEq(e.creatorT, (e.sP * 5000) / 10_000);
        m = _mark(token);
        Snap memory s = _snap(token, dave);
        _harvest(token, e, dave);
        _check(token, e, s, dave);
        Split memory pool = _since(token, m, dave);
        // thirds, as on the curve (rounding dust to the treasury)
        assertApproxEqAbs(pool.treasury * 3, e.quoteOut, 4, "a third the launchpad's");
        assertApproxEqAbs(pool.creator * 3, e.quoteOut, 4, "a third the creator's");
        assertApproxEqAbs(pool.holders * 3, e.quoteOut, 4, "a third the holders'");
        assertApproxEqRel(
            (pool.treasury * 1e18) / pool.creator, (curve.treasury * 1e18) / curve.creator, 1e13, "the curve's proportion"
        );
        // and about the same quote: the tax in coins, sold back into the pool it came from
        assertApproxEqRel(e.quoteOut, fee, 0.02e18, "within 2%: the sale's slippage and Uniswap's fee");
    }

    /// At a size where the pool would mint nothing of the liquidity share, none of it is kept as
    /// coins: the whole share is sold with the rest and its quote goes to the burn pot — which, for a
    /// share that small, is what its sale rounds to. The point is the branch: no LP minted, nothing
    /// left in the migrator, the quote all accounted for.
    function test_liquidityShareIsSoldWhenThePoolWouldMintNothing() public {
        address token = _create(address(cb), custom);
        _graduate(token);
        _fund(carol, token, 500);
        _poolBuy(carol, token, 500); // a ten-millionth of a cbLTC: a few coins, the liquidity share a hundredth of one
        Exp memory e = _expected(token, false);
        assertFalse(e.doDeepen, "the sold half of the share would not mint a unit of LP");
        assertEq(e.deepenT, 0, "so nothing is kept");
        assertEq(e.sellT, e.slice - e.burnT, "everything but the burn share is sold");
        assertGt(e.quoteOut, 0);
        assertEq(e.toBurnPot, e.qL);
        uint256 lpBefore = MockV2Pair(migrator.pairOf(token)).balanceOf(address(migrator));
        Snap memory s = _snap(token, dave);
        _harvest(token, e, dave);
        _check(token, e, s, dave);
        assertEq(MockV2Pair(migrator.pairOf(token)).balanceOf(address(migrator)), lpBefore, "no LP minted");
        assertEq(pad.burnPot(token), s.burnPot + e.qL);
    }

    // ---------------------------------------------------------- cap and cooldown

    /// One harvest a block per coin.
    function test_aSecondHarvestInTheSameBlockWaits() public {
        address token = _create(address(cb), custom);
        _graduate(token);
        _fillBuckets(token);
        uint256 total = pad.taxTreasury(token) + pad.taxPot(token);
        vm.prank(dave);
        (uint256 first,,) = migrator.harvest(token);
        assertLt(first, total, "a slice: more waits");
        assertEq(migrator.nextHarvestBlock(token), block.number + 1);
        vm.prank(dave);
        vm.expectRevert(UniV2Migrator.HarvestCooldown.selector);
        migrator.harvest(token);
        vm.roll(block.number + 1);
        Exp memory e = _expected(token, false);
        Snap memory s = _snap(token, carol);
        _harvest(token, e, carol); // the next block, the next slice, whoever calls
        _check(token, e, s, carol);
    }

    /// With more in the buckets than a slice, one harvest sells exactly the cap: the coins whose
    /// sale takes half a percent of the pool's quote side, a wei of rounding at most.
    function test_aHarvestMovesThePoolHalfAPercentAtMost() public {
        address token = _create(address(cb), custom);
        _graduate(token);
        _fillBuckets(token);
        (uint256 rToken, uint256 rQuote) = _reserves(token);
        uint256 out = rQuote / 200;
        uint256 cap = (rToken * out * 1000) / ((rQuote - out) * 997) + 1;
        assertEq(migrator.harvestCap(token), cap, "Uniswap's getAmountIn for half a percent of the quote side");
        Exp memory e = _expected(token, false);
        assertEq(e.slice, cap, "the slice is the cap");
        assertLt(cap, e.tT + e.tP);
        Snap memory s = _snap(token, dave);
        _harvest(token, e, dave);
        _check(token, e, s, dave);
        (, uint256 rQuoteAfter) = _reserves(token);
        // the cap bounds the sale at half a percent of the quote side (+1 wei of rounding); the sale is
        // smaller still, since the burn share and the kept half of the liquidity share are never sold,
        // and the deepening puts the liquidity share's quote back in
        assertLe(e.quoteOut, rQuote / 200 + 1, "the sale takes half a percent at most");
        assertEq(rQuote - rQuoteAfter, e.quoteOut - e.qL, "the quote side moved by the sale, less what the deepening returned");
        assertLe(rQuote - rQuoteAfter, rQuote / 200 + 1, "never more than half a percent out of the quote side");
        assertGt(pad.taxTreasury(token) + pad.taxPot(token), 0, "the rest waits for the next block");

        // the native pool, the same bound
        address native = _create(address(0), custom);
        _graduate(native);
        _fillBuckets(native);
        (rToken, rQuote) = _reserves(native);
        out = rQuote / 200;
        cap = (rToken * out * 1000) / ((rQuote - out) * 997) + 1;
        assertEq(migrator.harvestCap(native), cap);
        vm.prank(dave);
        (uint256 tokensIn, uint256 quoteOut,) = migrator.harvest(native);
        assertEq(tokensIn, cap, "native: the slice is the cap");
        assertLe(quoteOut, rQuote / 200 + 1, "native: the sale takes half a percent at most");
        (, rQuoteAfter) = _reserves(native);
        assertLe(rQuote - rQuoteAfter, rQuote / 200 + 1, "native: never more than half a percent");
    }

    // ----------------------------------------------------------------- rush

    /// A freeze announced: the harvest ignores the cap and the cooldown, so the buckets can be
    /// emptied before it lands; once it lands, the launchpad refuses to hand coins out.
    function test_rushModeEmptiesTheBucketsBeforeAFreeze() public {
        address token = _create(address(cb), custom);
        _graduate(token);
        _fillBuckets(token);
        uint256 total = pad.taxTreasury(token) + pad.taxPot(token);
        assertGt(total, migrator.harvestCap(token));
        uint256 cooldownBefore = migrator.nextHarvestBlock(token);

        mig.announceFreeze(block.number + 5);
        assertEq(pad.freezeBlock(), block.number + 5);
        assertFalse(pad.frozen(), "announced, not landed: trading goes on");
        Exp memory e = _expected(token, true);
        assertEq(e.slice, total, "the whole of both buckets, cap or no cap");
        Snap memory s = _snap(token, dave);
        _harvest(token, e, dave);
        _check(token, e, s, dave);
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), 0, "emptied");
        assertEq(migrator.nextHarvestBlock(token), cooldownBefore, "no cooldown set in a rush");
        vm.prank(dave);
        vm.expectRevert(UniV2Migrator.NothingToSell.selector);
        migrator.harvest(token); // nothing left, not a cooldown

        // trades go on until the freeze, and so do harvests: same block, no slice limit
        _fund(carol, token, 20e8);
        _poolBuy(carol, token, 20e8);
        e = _expected(token, true);
        assertEq(e.slice, pad.taxTreasury(token) + pad.taxPot(token));
        s = _snap(token, carol);
        _harvest(token, e, carol);
        _check(token, e, s, carol);

        // the last trades before the freeze leave coins in the buckets; frozen, the launchpad hands none out
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        assertGt(pad.taxTreasury(token) + pad.taxPot(token), 0);
        address pair = migrator.pairOf(token);
        vm.roll(block.number + 5);
        assertTrue(pad.frozen());
        vm.prank(carol);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        IERC20(token).transfer(pair, 1e18); // no trade either
        vm.prank(dave);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        migrator.harvest(token);
    }

    // --------------------------------------------------------------- no tax

    /// A coin with no tax of its own: the launchpad's 0.5% alone is taken, and a harvest hands
    /// all of it to the treasury, the caller's twentieth aside. Nothing for the creator, the
    /// holders or the pots.
    function test_aCoinWithoutTaxHarvestsForTheTreasuryAlone() public {
        vm.prank(alice);
        address token = pad.createToken("Plain", "PLN", 0, meta, address(cb), false);
        assertEq(_fees(token).platformBps, 50);
        assertEq(_fees(token).buyTaxBps + _fees(token).sellTaxBps, 0);
        _graduate(token);
        _fund(carol, token, 2e8);
        (uint256 gross,) = _poolBuy(carol, token, 2e8);
        assertEq(pad.taxTreasury(token), (gross * 50) / 10_000, "half a percent, all the launchpad's");
        assertEq(pad.taxPot(token), 0, "no tax, no pot");
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2);
        assertEq(pad.taxPot(token), 0);

        Exp memory e = _expected(token, false);
        assertEq(e.sP + e.burnT + e.liqT + e.creatorT + e.holdersT, 0, "no share of the coin's");
        assertEq(e.sellT, e.slice, "everything is sold");
        assertEq(e.qT + e.tip, e.quoteOut, "everything is the treasury's");
        assertEq(e.tip, e.quoteOut / 20);
        Snap memory s = _snap(token, dave);
        _harvest(token, e, dave);
        _check(token, e, s, dave);
        assertEq(pad.creatorFees(alice, address(cb)), s.creatorQ, "nothing for the creator");
        assertEq(pad.accCashbackPerShare(token), s.acc, "nothing for holders");
        assertEq(pad.burnPot(token) + pad.liquidityPot(token), 0, "nothing for the pots");
        assertEq(cb.balanceOf(treasury) - s.treasuryQ, e.quoteOut - e.quoteOut / 20);
        assertEq(cb.balanceOf(dave), e.quoteOut / 20);
    }

    /// A coin launched while the launchpad's fee was 0 and with no tax: no transfer ever pays,
    /// the buckets stay empty, a harvest has nothing to sell — and onTax never runs on a rate of 0.
    function test_aCoinStampedWithNoPlatformFeeIsNeverTaxed() public {
        pad.setFeeBps(0);
        vm.prank(alice);
        address token = pad.createToken("Free", "FREE", 0, meta, address(cb), false);
        assertEq(_fees(token).platformBps, 0, "stamped at launch");
        pad.setFeeBps(50); // later coins pay again; this one never will
        _graduate(token);
        address pair = migrator.pairOf(token);
        assertEq(pad.transferRate(token, pair, carol), 0, "a buy pays nothing");
        assertEq(pad.transferRate(token, carol, pair), 0, "a sell pays nothing");
        uint256 padTokens = IERC20(token).balanceOf(address(pad));
        _fund(carol, token, 5e8);
        (uint256 gross, uint256 net) = _poolBuy(carol, token, 5e8);
        assertEq(net, gross, "the buyer gets the pair's whole payout");
        _poolSell(carol, token, net / 2);
        assertEq(pad.taxTreasury(token) + pad.taxPot(token), 0, "the buckets stay empty");
        assertEq(IERC20(token).balanceOf(address(pad)), padTokens, "not a coin reached the pad");
        assertGt(migrator.harvestCap(token), 0, "the pool is there to sell into");
        vm.prank(dave);
        vm.expectRevert(UniV2Migrator.NothingToSell.selector);
        migrator.harvest(token);
    }

    // ----------------------------------------------------------------- roles

    /// Anyone harvests; only the coin's migrator takes coins from the pad or pays it quote.
    function test_anyoneHarvestsOnlyTheMigratorTakesAndPays() public {
        address token = _create(address(cb), custom);
        _graduate(token);
        _fund(carol, token, 2e8);
        _poolBuy(carol, token, 2e8);
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        (uint256 tokensIn,,) = migrator.harvest(token);
        assertGt(tokensIn, 0, "an EOA with no role harvested");
        assertGt(cb.balanceOf(nobody), 0, "and was tipped");

        vm.expectRevert(LaunchpadBase.NotMigrator.selector);
        pad.takeTax(token, 0, 0, 0); // the owner is nobody here
        vm.prank(alice);
        vm.expectRevert(LaunchpadBase.NotMigrator.selector);
        pad.takeTax(token, 0, 0, 0); // nor the creator
        vm.prank(alice);
        vm.expectRevert(LaunchpadBase.NotMigrator.selector);
        pad.poolFee(token, 0, 0, 0, 0);
        vm.prank(address(migrator));
        vm.expectRevert(LaunchpadBase.NotMigrator.selector);
        pad.takeTax(makeAddr("not a coin"), 0, 0, 0); // the migrator, but not this coin's

        // a coin graduated with no migrator at all: graduatedVia is the zero address, which is nobody's
        pad.setMigrator(address(0));
        address orphan = _create(address(cb), custom);
        _curveBuy(bob, orphan, 200e8);
        assertEq(address(pad.graduatedVia(orphan)), address(0));
        vm.prank(address(0));
        vm.expectRevert(LaunchpadBase.NotMigrator.selector);
        pad.takeTax(orphan, 0, 0, 0);
        vm.prank(address(0));
        vm.expectRevert(LaunchpadBase.NotMigrator.selector);
        pad.poolFee(orphan, 0, 0, 0, 0);
    }

    /// The holders' share goes to holders — not to the pool, whose coins are not anyone's, nor to the migrator.
    function test_thePoolAndTheMigratorEarnNoCashback() public {
        address token = _create(address(cb), custom);
        _graduate(token);
        address pair = migrator.pairOf(token);
        _fund(carol, token, 2e8);
        _poolBuy(carol, token, 2e8);
        _poolSell(carol, token, IERC20(token).balanceOf(carol) / 2); // the pool holds more than it did
        assertGt(IERC20(token).balanceOf(pair), 0);
        uint256 pairBefore = pad.cashbackOf(token, pair);
        uint256 migratorBefore = pad.cashbackOf(token, address(migrator));
        uint256 bobBefore = pad.cashbackOf(token, bob);
        vm.prank(dave);
        migrator.harvest(token);
        assertGt(pad.cashbackOf(token, bob), bobBefore, "a holder's cashback grew");
        assertEq(pad.cashbackOf(token, pair), pairBefore, "the pool's did not");
        assertEq(pad.cashbackOf(token, address(migrator)), migratorBefore, "nor the migrator's");
    }

    // --------------------------------------------------------------- sandwich

    /// A trader who buys just before a harvest and sells right after loses: both legs pay the
    /// coin's 1% and the launchpad's 0.5% in coins and Uniswap's 0.3%, and the harvest moved the
    /// price half a percent at most — against them, as it sells. The tip, theirs too, does not cover it.
    function test_aBuyAndSellAroundAHarvestLoses() public {
        address token = _create(address(cb), onePercent);
        _graduate(token);
        _fillBuckets(token);
        uint256 stake = 1e8;
        _fund(eve, token, stake);
        _poolBuy(eve, token, stake);
        uint256 cap = migrator.harvestCap(token);
        vm.prank(eve);
        (uint256 tokensIn,,) = migrator.harvest(token);
        assertEq(tokensIn, cap, "a slice: the most a harvest moves the pool");
        _poolSell(eve, token, IERC20(token).balanceOf(eve));
        assertEq(IERC20(token).balanceOf(eve), 0);
        assertLt(cb.balanceOf(eve), stake, "out with less than went in, the tip included");
        assertGt(cb.balanceOf(eve), (stake * 90) / 100, "(and not ruined: the taxes and the fee, about 4%)");
    }

    /// The other way round, the one that would profit from a sale: sell first, let the harvest
    /// push the price further down, buy back cheaper. The half-percent gain is less than the
    /// taxes and fees both legs pay: fewer coins than before.
    function test_aSellAndBuyAroundAHarvestLoses() public {
        address token = _create(address(cb), onePercent);
        _graduate(token);
        _fund(eve, token, 1e8);
        _poolBuy(eve, token, 1e8);
        uint256 coins = IERC20(token).balanceOf(eve);
        vm.roll(block.number + 1);
        _fillBuckets(token);
        assertEq(cb.balanceOf(eve), 0);
        _poolSell(eve, token, coins);
        vm.prank(eve);
        migrator.harvest(token);
        _poolBuy(eve, token, cb.balanceOf(eve)); // everything back in, the tip too
        assertEq(cb.balanceOf(eve), 0);
        assertLt(IERC20(token).balanceOf(eve), coins, "fewer coins than she started with");
        assertGt(IERC20(token).balanceOf(eve), (coins * 90) / 100);
    }
}
