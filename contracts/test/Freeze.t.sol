// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {LaunchTokenFactory} from "../src/LaunchTokenFactory.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";

/// The migration to another chain, from this side: the freeze that makes the
/// snapshot final, and migrateOut, which takes each coin's quote to the bridge.
contract FreezeTest is Test {
    Launchpad pad;
    UniV2Migrator migrator;
    MockCbLTC quote;
    MockWETH9 weth;
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
        pad = new Launchpad(treasury);
        quote = new MockCbLTC();
        pad.setQuoteAsset(address(quote), 30e8); // 30 cbLTC virtual, as on Base
        pad.setQuoteAsset(address(0), 0); // and cbLTC alone, as on Base
        weth = new MockWETH9();
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

    /// A coin as a ledger left it: alice's, its pot to her, on a 1.25 ETH curve, nothing burned, no pots.
    function _ledgerCoin(string memory name, string memory symbol, uint256 sold) internal view returns (Launchpad.LedgerCoin memory) {
        return Launchpad.LedgerCoin({
            name: name,
            symbol: symbol,
            meta: meta,
            creator: alice,
            fees: Launchpad.FeeConfig(0, 0, 10_000, 0, 0, 0),
            virtualQuote: 1.25 ether,
            sold: sold,
            burned: 0,
            poolToken: 0,
            burnPot: 0,
            liquidityPot: 0
        });
    }

    function _reserves(address pair, address token) internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rToken, rQuote) = MockV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
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
        vm.expectRevert(Launchpad.CreationClosed.selector);
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

    // ------------------------------------------------- what the pad takes in

    function test_nativeQuoteIsOffOnThisPad() public {
        vm.prank(alice);
        vm.expectRevert(Launchpad.QuoteAssetNotEnabled.selector);
        pad.createToken("Eth Coin", "ETHC", 0, meta, address(0), false);
        // a pad quoted in its chain's own coin switches it on like any other quote
        pad.setQuoteAsset(address(0), pad.VIRTUAL_ETH());
        vm.prank(alice);
        address coin = pad.createToken("Eth Coin", "ETHC", 0, meta, address(0), false);
        assertEq(_curve(coin).vEth, 1.25 ether);
    }

    function test_creationClosesAtTheAnnouncement() public {
        pad.announceFreeze(block.number + 5);
        vm.prank(alice);
        vm.expectRevert(Launchpad.CreationClosed.selector);
        pad.createToken("Late", "LATE", 0, meta, address(quote), false);
        _buy(bob, curveCoin, 1e8); // trading goes on until the block
        pad.cancelFreeze();
        vm.prank(alice);
        pad.createToken("Late", "LATE", 0, meta, address(quote), false); // open again
    }

    function test_sameBlockFreezeIsImmediate() public {
        pad.announceFreeze(block.number);
        assertTrue(pad.frozen());
        vm.expectRevert(Launchpad.BadFreeze.selector);
        pad.cancelFreeze();
    }

    function test_strangerCannotUseTheFactory() public {
        LaunchTokenFactory f = pad.tokenFactory();
        assertEq(f.launchpad(), address(pad));
        vm.prank(bob);
        vm.expectRevert(LaunchTokenFactory.OnlyLaunchpad.selector);
        f.create("Fake", "FAKE", 1e18, true);
    }

    function test_inboundMigrationStopsWithTheFreeze() public {
        // a coin arriving from a ledger, half delivered: no freeze is announced over it
        pad.setMigrationRoot(bytes32(uint256(1)), 1);
        uint256 sold = 100e18;
        uint256 quoteIn = Math.mulDiv(1.25 ether, sold, pad.VIRTUAL_TOKEN() - sold);
        Launchpad.LedgerCoin memory coin = _ledgerCoin("Ledger Coin", "LEDG", sold);
        address[] memory holders = new address[](1);
        uint256[] memory balances = new uint256[](1);
        holders[0] = bob;
        balances[0] = sold / 2;
        vm.deal(address(this), quoteIn);
        address token = pad.migrateToken{value: quoteIn}(coin, holders, balances);
        assertEq(pad.migrationPending(token), sold / 2);
        assertEq(pad.pendingCoins(), 1);
        vm.expectRevert(Launchpad.MigrationPending.selector);
        pad.announceFreeze(block.number + 5);
        // delivered whole, the freeze can come; announced, no coin arrives; landed, none is delivered
        holders[0] = carol;
        pad.migrateBalances(token, holders, balances);
        assertEq(pad.pendingCoins(), 0);
        pad.announceFreeze(block.number + 5);
        Launchpad.LedgerCoin memory another = _ledgerCoin("Another", "ANOT", 0);
        vm.expectRevert(Launchpad.CreationClosed.selector);
        pad.migrateToken(another, new address[](0), new uint256[](0));
        vm.roll(block.number + 5);
        vm.expectRevert(Launchpad.Frozen.selector);
        pad.migrateBalances(token, holders, balances);
    }

    function test_claimCashbackWhileFrozen() public {
        vm.prank(alice);
        address h = pad.createToken("Holders Coin", "HOLD", 0, meta, address(quote), true);
        _buy(bob, h, 5e8);
        _buy(carol, h, 5e8); // carol's fee is bob's cashback
        uint256 owed = pad.cashbackOf(h, bob);
        assertGt(owed, 0);
        _freeze();
        vm.prank(bob);
        pad.claimCashback(h);
        assertEq(quote.balanceOf(bob), owed);
    }

    /// The pad's own arithmetic for a first buy of `first` on a fresh 30 cbLTC curve,
    /// and the amount that then sells the curve out (rounded against the buyer).
    function _needAfter(uint256 first) internal view returns (uint256 need) {
        uint256 vEth = 30e8;
        uint256 vToken = pad.VIRTUAL_TOKEN();
        uint256 forCurve = first - first / 100;
        uint256 out = vToken - (vEth * vToken) / (vEth + forCurve);
        uint256 x = vEth + forCurve;
        uint256 y = vToken - out;
        need = (x * y) / (y - (pad.CURVE_SUPPLY() - out)) - x + 1;
    }

    function test_graduatingBuyRoundingComesOffTheFee() public {
        // the wei the fee gross-up can add must never come out of the other coins' reserves: find a
        // first buy after which the amount that sells the curve out is a multiple of 99, then buy
        // exactly that with an ethIn ending in 99 — the case where fee + curve would be ethIn + 1
        pad.setMigrator(address(0)); // the reserve stays parked, so the pad's balance must cover it
        vm.prank(alice);
        address coin = pad.createToken("Round", "RND", 0, meta, address(quote), false);
        uint256 first = 1e8;
        while (_needAfter(first) % 99 != 0) first++;
        uint256 need = _needAfter(first);
        _buy(bob, coin, first);
        assertEq(_curve(coin).vEth, 30e8 + first - first / 100, "the model matches the pad");
        uint256 ethIn = (need / 99) * 100 - 1; // its fee is need/99 - 1, so the curve gets exactly `need`
        _buy(dave, coin, ethIn);
        assertTrue(_curve(coin).graduated);
        uint256 owed = _curve(coin).realEth + _curve(curveCoin).realEth + pad.creatorFees(alice, address(quote));
        assertGe(quote.balanceOf(address(pad)), owed, "the pad covers every reserve and every fee");
    }

    // ------------------------------------------ the pool a migrated coin left

    function test_otherProvidersLeaveThePoolAfterMigrateOut() public {
        (address pair, uint256 lp, uint256 addQuote) = _daveAddsLiquidity();
        uint256 lpOurs = migrator.liquidity(gradCoin);
        uint256 lpTotal = MockV2Pair(pair).totalSupply();
        (uint256 rToken, uint256 rQuote) = _reserves(pair, gradCoin);
        _freeze();

        // frozen: the pool pays nobody out
        _expectSwapFrozen(pair);

        // migrateOut takes our share and no more: what the snapshot counted as the pool
        (uint256 quoteOut, uint256 burned) = pad.migrateOut(gradCoin, cold);
        assertEq(pad.migratedPair(gradCoin), pair);
        assertEq(quoteOut, (rQuote * lpOurs) / lpTotal, "our LP's share of the pool's quote, dave's stays");
        assertEq(burned, (rToken * lpOurs) / lpTotal, "and of its coins");

        _bobBuysOutOfThePool(pair);
        _daveWithdraws(pair, lp, addQuote);
        // but nothing goes the other way: not to a wallet, not into the pool
        vm.startPrank(dave);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(bob, 1);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(pair, 1);
        vm.stopPrank();
    }

    /// dave adds liquidity of his own to the graduated coin's pool, before the freeze
    function _daveAddsLiquidity() internal returns (address pair, uint256 lp, uint256 addQuote) {
        pair = migrator.pairOf(gradCoin);
        (uint256 rToken, uint256 rQuote) = _reserves(pair, gradCoin);
        addQuote = rQuote / 10 + 1;
        quote.mint(dave, addQuote);
        vm.startPrank(dave);
        IERC20(gradCoin).transfer(pair, rToken / 10);
        quote.transfer(pair, addQuote);
        lp = MockV2Pair(pair).mint(dave);
        vm.stopPrank();
        assertGt(lp, 0);
    }

    function _expectSwapFrozen(address pair) internal {
        (uint256 out0, uint256 out1) =
            MockV2Pair(pair).token0() == gradCoin ? (uint256(1e18), uint256(0)) : (uint256(0), uint256(1e18));
        vm.prank(bob);
        vm.expectRevert(LaunchToken.Frozen.selector);
        MockV2Pair(pair).swap(out0, out1, bob, "");
    }

    /// the pool is open on the way out: bob may buy the inert Base copy out of it
    function _bobBuysOutOfThePool(address pair) internal {
        quote.mint(bob, 1e6);
        (uint256 rToken, uint256 rQuote) = _reserves(pair, gradCoin);
        uint256 out = (1e6 * 997 * rToken) / (rQuote * 1000 + 1e6 * 997);
        (uint256 out0, uint256 out1) = MockV2Pair(pair).token0() == gradCoin ? (out, uint256(0)) : (uint256(0), out);
        vm.startPrank(bob);
        quote.transfer(pair, 1e6);
        MockV2Pair(pair).swap(out0, out1, bob, "");
        vm.stopPrank();
        assertEq(IERC20(gradCoin).balanceOf(bob), out);
    }

    /// and dave withdraws his liquidity, his cbLTC whole
    function _daveWithdraws(address pair, uint256 lp, uint256 addQuote) internal {
        uint256 daveCoins = IERC20(gradCoin).balanceOf(dave);
        uint256 daveQuote = quote.balanceOf(dave); // the refund of his graduating buy is in there
        vm.startPrank(dave);
        MockV2Pair(pair).transfer(pair, lp);
        (uint256 a0, uint256 a1) = MockV2Pair(pair).burn(dave);
        vm.stopPrank();
        assertGt(a0, 0);
        assertGt(a1, 0);
        assertGt(IERC20(gradCoin).balanceOf(dave), daveCoins);
        assertApproxEqRel(quote.balanceOf(dave) - daveQuote, addQuote, 0.01e18);
    }

    function test_nativeGraduatedCoinUnlocksToWeth() public {
        pad.setQuoteAsset(address(0), pad.VIRTUAL_ETH());
        vm.prank(alice);
        address coin = pad.createToken("Eth Coin", "ETHC", 0, meta, address(0), false);
        vm.deal(dave, 10 ether);
        vm.prank(dave);
        pad.buy{value: 6 ether}(coin, 0); // the curve raises ~4 ETH: it graduates into a token/WETH pool
        assertTrue(_curve(coin).graduated);
        address pair = migrator.pairOf(coin);
        (, uint256 rQuote) = _reserves(pair, coin);
        assertGt(rQuote, 3 ether);
        _freeze();
        (uint256 quoteOut, uint256 burned) = pad.migrateOut(coin, cold);
        assertGe(quoteOut, (rQuote * 999) / 1000);
        assertEq(weth.balanceOf(cold), quoteOut, "the pool's WETH as WETH: no call into the bridge account");
        assertEq(cold.balance, 0);
        assertGt(burned, 0);
    }

    // ------------------------------------------ coins quoted in a pre-market

    function test_coinsQuotedInAPreMarketMigrateOutAndPayTheirFees() public {
        (address pre, address x, address y) = _preMarketWorld();
        uint256 owedPre = pad.creatorFees(alice, pre);
        assertGt(owedPre, 0);
        uint256 xReserve = _curve(x).realEth;
        _freeze();

        // the pre-market is frozen like any coin of this pad...
        vm.prank(bob);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(pre).transfer(carol, 1e18);
        // ...and still the pad pays out in it: fee claims, the reserves leaving, the pool unlocking
        vm.prank(alice);
        pad.claimCreatorFees(pre);
        assertEq(IERC20(pre).balanceOf(alice), owedPre);
        (uint256 outX,) = pad.migrateOut(x, cold);
        assertEq(outX, xReserve);
        (uint256 outY, uint256 burnedY) = pad.migrateOut(y, cold);
        assertGt(outY, 0);
        assertGt(burnedY, 0);
        assertEq(IERC20(pre).balanceOf(cold), xReserve + outY);
        assertEq(pad.unlocking(), address(0));
        // PRE's own ETH reserve leaves like any curve's
        (uint256 outPre,) = pad.migrateOut(pre, cold);
        assertGt(outPre, 0);
        assertEq(cold.balance, outPre);
    }

    /// a pre-market on its ETH curve, a coin on a PRE curve and one graduated into a PRE pool
    function _preMarketWorld() internal returns (address pre, address x, address y) {
        pad.setQuoteAsset(address(0), pad.VIRTUAL_ETH()); // a pre-market lives on an ETH curve
        pre = pad.createPreMarket("Pre Market", "PRE", meta, 1_000_000e18); // curves paired with it open at 1M PRE virtual
        vm.deal(bob, 10 ether);
        vm.prank(bob);
        pad.buy{value: 2 ether}(pre, 0);
        assertGt(IERC20(pre).balanceOf(bob), 5_000_000e18);
        vm.startPrank(alice);
        x = pad.createToken("X Coin", "XC", 0, meta, pre, false);
        y = pad.createToken("Y Coin", "YC", 0, meta, pre, false);
        vm.stopPrank();
        vm.startPrank(bob);
        IERC20(pre).approve(address(pad), type(uint256).max);
        pad.buyWithQuote(x, 100_000e18, 0);
        pad.buyWithQuote(y, 4_000_000e18, 0); // the curve raises ~3.2M PRE: it graduates
        vm.stopPrank();
        assertTrue(_curve(y).graduated);
        assertGt(migrator.liquidity(y), 0);
    }
}
