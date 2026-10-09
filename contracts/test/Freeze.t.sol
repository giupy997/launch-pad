// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {LaunchTokenFactory} from "../src/LaunchTokenFactory.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair, IUniswapV2Callee} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";

/// A flash-swap borrower: takes coins out of the pair with `data` set and, in
/// the callback, either has the migrator harvest, sells the coins back into
/// the pair, or simply repays in quote. The first two come back into a pair
/// that is mid-swap — Uniswap's lock refuses them, and the whole flash swap
/// unwinds with them; the third is what a flash swap is for, and lands.
contract FlashBorrower is IUniswapV2Callee {
    enum Then {
        Harvest,
        SellBack,
        Repay
    }

    UniV2Migrator immutable migrator;
    address immutable token;
    IERC20 immutable quote;
    MockV2Pair immutable pair;
    Then then;
    uint256 repay;

    constructor(UniV2Migrator migrator_, address token_, IERC20 quote_, MockV2Pair pair_) {
        migrator = migrator_;
        token = token_;
        quote = quote_;
        pair = pair_;
    }

    function flash(uint256 tokensOut, Then then_, uint256 repay_) external {
        then = then_;
        repay = repay_;
        (uint256 out0, uint256 out1) = pair.token0() == token ? (tokensOut, uint256(0)) : (uint256(0), tokensOut);
        pair.swap(out0, out1, address(this), "x");
    }

    function uniswapV2Call(address, uint256, uint256, bytes calldata) external {
        require(msg.sender == address(pair), "not the pair");
        if (then == Then.Harvest) {
            migrator.harvest(token);
        } else if (then == Then.SellBack) {
            IERC20(token).transfer(address(pair), IERC20(token).balanceOf(address(this)));
            (uint256 out0, uint256 out1) = pair.token0() == token ? (uint256(0), uint256(1)) : (uint256(1), uint256(0));
            pair.swap(out0, out1, address(this), "");
        } else {
            quote.transfer(address(pair), repay);
        }
    }
}

/// The migration to another chain, from this side: the freeze that makes the
/// snapshot final, and migrateOut, which takes each coin's quote to the bridge.
/// Both coins here carry a tax of their own on top of the launchpad's 0.5%, so
/// the freeze is tested against everything that tax feeds: the creator's and
/// the holders' claims, the pots, and the buckets a graduated coin's pool
/// trades fill (taxTreasury, taxPot) — harvested in a rush before the freeze,
/// burned with the pool's token side at migrateOut.
contract FreezeTest is Test {
    Launchpad pad;
    ILaunchpadMigration mig;
    UniV2Migrator migrator;
    MockCbLTC quote;
    MockWETH9 weth;
    MockV2Factory factory;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates both coins
    address bob = makeAddr("bob");
    address carol = makeAddr("carol"); // trades the graduated coin's pool
    address dave = makeAddr("dave"); // graduates the second coin
    address cold = makeAddr("cold"); // the account that bridges
    address curveCoin;
    address gradCoin;
    address gradPair;
    LaunchpadBase.TokenMetadata meta = LaunchpadBase.TokenMetadata("", "", "", "", "", "");
    /// 1% each way, all of it the creator's: a curve coin that leaves nothing behind but its reserve and her claim
    LaunchpadBase.FeeConfig creatorOnly = LaunchpadBase.FeeConfig(100, 100, 10_000, 0, 0, 0, 0);
    /// 1% each way; the tax half to the creator, a fifth to holders, a fifth burned, a tenth to liquidity: every share in play
    LaunchpadBase.FeeConfig taxed = LaunchpadBase.FeeConfig(100, 100, 5000, 2000, 2000, 1000, 0);
    /// The launchpad's fee, stamped on every coin at creation.
    uint256 constant PLATFORM = 50;
    /// What a trade on the graduated coin's pool pays, either way: the launchpad's 0.5% and the coin's 1%.
    uint256 constant RATE = 150;
    bytes32 constant TAXED = keccak256("Taxed(address,bool,uint256)");

    function setUp() public {
        pad = new Launchpad(treasury);
        mig = ILaunchpadMigration(address(pad));
        quote = new MockCbLTC();
        pad.setQuoteAsset(address(quote), 30e8); // 30 cbLTC virtual, as on Base
        pad.setQuoteAsset(address(0), 0); // and cbLTC alone, as on Base
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        pad.setMigrator(address(migrator));
        assertEq(pad.feeBps(), PLATFORM, "0.5% a side, whole to the treasury");

        vm.startPrank(alice);
        curveCoin = pad.createTokenWithFees("Curve Coin", "CURVE", 0, meta, address(quote), creatorOnly);
        gradCoin = pad.createTokenWithFees("Grad Coin", "GRAD", 0, meta, address(quote), taxed);
        vm.stopPrank();

        _buy(bob, curveCoin, 5e8);
        _buy(carol, curveCoin, 3e8);
        // 1.5% of each buy is the fee; a third of it (the 0.5%) is the treasury's, the rest the coin's tax, all alice's
        assertEq(pad.creatorFees(alice, address(quote)), 5e6 + 3e6, "1% of 8 cbLTC, the creator's");
        _buy(dave, gradCoin, 200e8); // the curve raises ~96 cbLTC: this graduates it and refunds the rest
        assertTrue(_curve(gradCoin).graduated, "GRAD graduated");
        gradPair = migrator.pairOf(gradCoin);
        assertGt(migrator.liquidity(gradCoin), 0, "its pool is seeded and locked");
        assertTrue(pad.taxedPool(gradCoin, gradPair), "and registered: its trades pay the fee and the tax");
        assertEq(pad.transferRate(gradCoin, gradPair, bob), RATE, "a buy");
        assertEq(pad.transferRate(gradCoin, bob, gradPair), RATE, "a sell");
        assertEq(pad.transferRate(gradCoin, dave, bob), 0, "wallet to wallet: free");
    }

    // ---------------------------------------------------------------- helpers

    function _buy(address who, address token, uint256 amount) internal {
        quote.mint(who, amount);
        vm.startPrank(who);
        quote.approve(address(pad), amount);
        pad.buyWithQuote(token, amount, 0);
        vm.stopPrank();
    }

    function _curve(address token) internal view returns (LaunchpadBase.Curve memory c) {
        (c.vEth, c.vToken, c.realEth, c.sold, c.graduated, c.creator, c.quoteAsset) = pad.curves(token);
    }

    function _fees(address token) internal view returns (LaunchpadBase.FeeConfig memory f) {
        (f.buyTaxBps, f.sellTaxBps, f.creatorBps, f.holdersBps, f.burnBps, f.liquidityBps, f.platformBps) =
            pad.feeConfig(token);
    }

    function _freeze() internal {
        mig.announceFreeze(block.number + 5);
        vm.roll(block.number + 5);
        assertTrue(pad.frozen());
    }

    /// A coin as a ledger left it: alice's, its pot to her, on a 1.25 ETH curve, nothing burned, no pots.
    function _ledgerCoin(string memory name, string memory symbol, uint256 sold)
        internal
        view
        returns (LaunchpadBase.LedgerCoin memory)
    {
        return LaunchpadBase.LedgerCoin({
            name: name,
            symbol: symbol,
            meta: meta,
            creator: alice,
            feeRecipient: address(0),
            fees: LaunchpadBase.FeeConfig(0, 0, 10_000, 0, 0, 0, 0),
            quoteAsset: address(0),
            quoteAmount: Math.mulDiv(1.25 ether, sold, pad.VIRTUAL_TOKEN() - sold),
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

    /// Uniswap v2's getAmountOut: the pool's own 0.3% on the way in.
    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        return (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
    }

    /// Uniswap v2's getAmountIn: what must come in for `amountOut` to go out.
    function _amountIn(uint256 amountOut, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        return (rIn * amountOut * 1000) / ((rOut - amountOut) * 997) + 1;
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

    /// How the pad books a tax taken at RATE: the launchpad's part by platformBps over the rate, the rest the coin's.
    function _split(uint256 tax) internal pure returns (uint256 platform, uint256 pot) {
        platform = (tax * PLATFORM) / RATE;
        pot = tax - platform;
    }

    function _buckets() internal view returns (uint256) {
        return pad.taxTreasury(gradCoin) + pad.taxPot(gradCoin);
    }

    /// A buy on the graduated coin's pool, as a router does it: the quote to the pair, the coins swapped
    /// out to `who`. The coin takes the rate the pad names off what the pair pays and books it there:
    /// the buyer gets the rest, and each bucket grows by exactly its part. Returns the pair's payout
    /// and the tax (0 once the coin has migrated out: the pool is then open on the way out, untaxed).
    function _poolBuy(address who, uint256 quoteIn) internal returns (uint256 gross, uint256 tax) {
        (uint256 rToken, uint256 rQuote) = _reserves(gradPair, gradCoin);
        gross = _amountOut(quoteIn, rQuote, rToken);
        tax = (gross * pad.transferRate(gradCoin, gradPair, who)) / 10_000;
        (uint256 out0, uint256 out1) = _outs(gradPair, gradCoin, gross, true);
        uint256 treasuryBefore = pad.taxTreasury(gradCoin);
        uint256 potBefore = pad.taxPot(gradCoin);
        uint256 whoBefore = IERC20(gradCoin).balanceOf(who);
        quote.mint(who, quoteIn);
        vm.startPrank(who);
        quote.transfer(gradPair, quoteIn);
        MockV2Pair(gradPair).swap(out0, out1, who, "");
        vm.stopPrank();
        assertEq(IERC20(gradCoin).balanceOf(who) - whoBefore, gross - tax, "the buyer gets the payout less the tax");
        (uint256 platform, uint256 pot) = _split(tax);
        assertEq(pad.taxTreasury(gradCoin) - treasuryBefore, platform, "the launchpad's part of the tax");
        assertEq(pad.taxPot(gradCoin) - potBefore, pot, "the coin's part");
    }

    /// A sell on the graduated coin's pool: the coins to the pair — the coin takes the rate on the way, so
    /// the pair gets the net — and the quote the net buys swapped out to `who`. Books as _poolBuy does.
    function _poolSell(address who, uint256 tokensIn) internal returns (uint256 net, uint256 quoteOut) {
        uint256 tax = (tokensIn * pad.transferRate(gradCoin, who, gradPair)) / 10_000;
        net = tokensIn - tax;
        (uint256 rToken, uint256 rQuote) = _reserves(gradPair, gradCoin);
        quoteOut = _amountOut(net, rToken, rQuote);
        (uint256 out0, uint256 out1) = _outs(gradPair, gradCoin, quoteOut, false);
        uint256 treasuryBefore = pad.taxTreasury(gradCoin);
        uint256 potBefore = pad.taxPot(gradCoin);
        uint256 quoteBefore = quote.balanceOf(who);
        vm.startPrank(who);
        IERC20(gradCoin).transfer(gradPair, tokensIn);
        assertEq(IERC20(gradCoin).balanceOf(gradPair) - rToken, net, "the pair gets the net");
        MockV2Pair(gradPair).swap(out0, out1, who, "");
        vm.stopPrank();
        assertEq(quote.balanceOf(who) - quoteBefore, quoteOut, "the quote the net buys");
        (uint256 platform, uint256 pot) = _split(tax);
        assertEq(pad.taxTreasury(gradCoin) - treasuryBefore, platform, "the launchpad's part of the tax");
        assertEq(pad.taxPot(gradCoin) - potBefore, pot, "the coin's part");
    }

    /// carol trades the pool until the buckets hold more than one harvest's slice.
    function _fillBuckets() internal {
        for (uint256 i = 0; i < 2; i++) {
            _poolBuy(carol, 50e8);
            _poolSell(carol, IERC20(gradCoin).balanceOf(carol));
        }
        assertGt(_buckets(), migrator.harvestCap(gradCoin), "more than a slice waits");
    }

    /// Of the logs recorded since vm.recordLogs: how many the pad emitted, and how many of those were Taxed.
    function _padLogs() internal view returns (uint256 fromPad, uint256 taxedEvents) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(pad)) continue;
            fromPad++;
            if (logs[i].topics[0] == TAXED) taxedEvents++;
        }
    }

    // ------------------------------------------------------------ the freeze

    function test_announcedFreezeLandsAtItsBlock() public {
        vm.prank(bob);
        vm.expectRevert();
        mig.announceFreeze(block.number + 5); // owner only

        mig.announceFreeze(block.number + 5);
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
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.buyWithQuote(curveCoin, 1e8, 0);
        uint256 bal = IERC20(curveCoin).balanceOf(bob);
        IERC20(curveCoin).approve(address(pad), bal);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.sell(curveCoin, bal, 0);
        vm.expectRevert(LaunchpadBase.CreationClosed.selector);
        pad.createToken("Late", "LATE", 0, meta, address(quote), false);
        // a coin on its curve could not move between wallets anyway; frozen, the refusal is the
        // freeze's — the token asks the pad before anything else — so nothing moves for any reason
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(curveCoin).transfer(carol, 1);
        vm.stopPrank();

        // a graduated coin trades freely on its DEX until the freeze: then not even a transfer
        vm.prank(dave);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(bob, 1e18);

        // a graduated coin whose pool was never seeded cannot be seeded now either
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.migrate(gradCoin);
    }

    /// §4: frozen, transferRate refuses every leg it is asked about — a trade's, a transfer's, the
    /// migrator's own — before any balance changes, with one exception while nothing is migrating out:
    /// the pad's own transfers (how migrateOut burns), at rate 0. (The other two exceptions, the coin
    /// whose pool is being unlocked and the pool a coin left, are the migrateOut tests below.)
    function test_whileFrozenOnlyThePadMovesCoins() public {
        _fillBuckets(); // carol holds some of the coin, the buckets are not empty
        _poolBuy(carol, 1e8);
        uint256 buckets = _buckets();
        assertGt(buckets, 0);
        _freeze();

        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(gradCoin, dave, bob); // wallet to wallet
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(gradCoin, carol, gradPair); // a sell
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(gradCoin, gradPair, carol); // a buy
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(gradCoin, address(migrator), gradPair); // the migrator's own leg: no harvest either
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(gradCoin, bob, address(pad)); // to the pad: no exception
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(curveCoin, bob, carol); // a coin on its curve
        assertEq(pad.transferRate(gradCoin, address(pad), bob), 0, "from the pad: free, and untaxed");
        assertEq(pad.transferRate(gradCoin, address(pad), gradPair), 0, "even into the pool");
        assertEq(pad.transferRate(gradCoin, address(pad), address(0)), 0, "a burn");

        // and the token does as the pad says: refused on the way in, out and across
        vm.prank(carol);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(gradPair, 1e18);
        (uint256 out0, uint256 out1) = _outs(gradPair, gradCoin, 1e18, true);
        vm.prank(bob);
        vm.expectRevert(LaunchToken.Frozen.selector);
        MockV2Pair(gradPair).swap(out0, out1, bob, "");
        vm.prank(carol);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(bob, 1e18);
        // the pad's own coins (the lock at graduation, the buckets) move: nothing of its own is ever
        // taxed, so the buckets do not change either
        assertGt(IERC20(gradCoin).balanceOf(address(pad)), 1e18);
        vm.prank(address(pad));
        IERC20(gradCoin).transfer(bob, 1e18);
        assertEq(IERC20(gradCoin).balanceOf(bob), 1e18);
        assertEq(_buckets(), buckets, "untouched by all of it");
    }

    function test_claimsKeepWorkingWhileFrozen() public {
        uint256 owed = pad.creatorFees(alice, address(quote));
        assertGt(owed, 8e6, "the curve coin's buys and half the graduating buy's tax: alice's");
        _freeze();
        vm.prank(alice);
        pad.claimCreatorFees(address(quote));
        assertEq(quote.balanceOf(alice), owed);
        assertEq(pad.creatorFees(alice, address(quote)), 0);
        vm.prank(alice);
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        pad.claimCreatorFees(address(quote)); // once
    }

    function test_freezeCanBeCancelledOnlyBeforeItLands() public {
        mig.announceFreeze(block.number + 5);
        vm.expectRevert(LaunchpadBase.BadFreeze.selector);
        mig.announceFreeze(block.number + 6); // one at a time
        mig.cancelFreeze();
        assertEq(pad.freezeBlock(), 0);
        _buy(bob, curveCoin, 1e8);

        vm.expectRevert(LaunchpadBase.BadFreeze.selector);
        mig.announceFreeze(block.number - 1); // never in the past

        _freeze();
        vm.expectRevert(LaunchpadBase.BadFreeze.selector);
        mig.cancelFreeze(); // landed: no way back
    }

    // ---------------------------------------------------------- migrateOut

    function test_migrateOutNeedsTheFreezeAndTheOwner() public {
        vm.expectRevert(LaunchpadBase.NotFrozen.selector);
        mig.migrateOut(curveCoin, cold);
        _freeze();
        vm.prank(bob);
        vm.expectRevert();
        mig.migrateOut(curveCoin, cold);
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        mig.migrateOut(curveCoin, address(0));
    }

    function test_migrateOutTakesACurveCoinsReserveWhole() public {
        uint256 reserve = _curve(curveCoin).realEth;
        assertGt(reserve, 0);
        assertEq(pad.burnPot(curveCoin) + pad.liquidityPot(curveCoin), 0, "a creator-only tax leaves no pots");
        uint256 padBefore = quote.balanceOf(address(pad));
        _freeze();

        (uint256 quoteOut, uint256 burned) = mig.migrateOut(curveCoin, cold);
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

        vm.expectRevert(LaunchpadBase.AlreadyMigratedOut.selector);
        mig.migrateOut(curveCoin, cold);
    }

    /// The unlock moves the coin while everything else is frozen: the pair pays our LP out to the
    /// migrator and the migrator hands the token side to the pad — legs transferRate lets through
    /// only because the coin is `unlocking` — and the pad burns it. Our LP is the whole pool but
    /// Uniswap's minimum liquidity, so what comes back is exactly that share of both sides.
    function test_migrateOutUnlocksAGraduatedCoinsPool() public {
        (uint256 rToken, uint256 rQuote) = _reserves(gradPair, gradCoin);
        uint256 lpOurs = migrator.liquidity(gradCoin);
        uint256 lpTotal = MockV2Pair(gradPair).totalSupply();
        assertEq(lpTotal, lpOurs + 1000, "ours and Uniswap's minimum, locked for good");
        uint256 burnPot = pad.burnPot(gradCoin);
        assertGt(burnPot, 0, "a fifth of the graduating buy's tax waits for a buyback");
        assertEq(pad.liquidityPot(gradCoin), 0, "the liquidity share joined the pool at graduation");
        assertEq(_buckets(), 0, "nothing traded on the pool: no tax in coins");
        uint256 supplyBefore = IERC20(gradCoin).totalSupply();
        uint256 daveBefore = IERC20(gradCoin).balanceOf(dave);
        _freeze();

        (uint256 quoteOut, uint256 burned) = mig.migrateOut(gradCoin, cold);
        assertEq(
            quoteOut,
            (rQuote * lpOurs) / lpTotal + burnPot,
            "our LP's share of the pool's quote and the burn pot, to the bridge"
        );
        assertEq(burned, (rToken * lpOurs) / lpTotal, "the pool's token side, burned");
        assertEq(quote.balanceOf(cold), quoteOut);
        assertEq(pad.burnPot(gradCoin), 0, "the pot went with it");
        assertEq(IERC20(gradCoin).totalSupply(), supplyBefore - burned, "the supply left is what holders own");
        assertEq(IERC20(gradCoin).balanceOf(dave), daveBefore, "holders keep theirs");
        assertEq(IERC20(gradCoin).balanceOf(address(migrator)), 0, "the migrator kept none");
        assertEq(migrator.liquidity(gradCoin), 0);
        assertEq(pad.unlocking(), address(0), "the transfer window closed again");
        assertTrue(pad.migratedOut(gradCoin));
        assertEq(pad.migratedPair(gradCoin), gradPair);

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
        (uint256 quoteOut, uint256 burned) = mig.migrateOut(parked, cold);
        assertEq(quoteOut, reserve);
        assertEq(burned, 0);
        assertEq(_curve(parked).realEth, 0);
    }

    // ------------------------------------------------- what the pad takes in

    function test_nativeQuoteIsOffOnThisPad() public {
        vm.prank(alice);
        vm.expectRevert(LaunchpadBase.QuoteAssetNotEnabled.selector);
        pad.createToken("Eth Coin", "ETHC", 0, meta, address(0), false);
        // a pad quoted in its chain's own coin switches it on like any other quote
        pad.setQuoteAsset(address(0), pad.VIRTUAL_ETH());
        vm.prank(alice);
        address coin = pad.createToken("Eth Coin", "ETHC", 0, meta, address(0), false);
        assertEq(_curve(coin).vEth, 1.25 ether);
    }

    function test_creationClosesAtTheAnnouncement() public {
        mig.announceFreeze(block.number + 5);
        vm.prank(alice);
        vm.expectRevert(LaunchpadBase.CreationClosed.selector);
        pad.createToken("Late", "LATE", 0, meta, address(quote), false);
        _buy(bob, curveCoin, 1e8); // trading goes on until the block
        mig.cancelFreeze();
        vm.prank(alice);
        pad.createToken("Late", "LATE", 0, meta, address(quote), false); // open again
    }

    function test_sameBlockFreezeIsImmediate() public {
        mig.announceFreeze(block.number);
        assertTrue(pad.frozen());
        vm.expectRevert(LaunchpadBase.BadFreeze.selector);
        mig.cancelFreeze();
    }

    function test_strangerCannotUseTheFactory() public {
        LaunchTokenFactory f = pad.tokenFactory();
        assertEq(f.launchpad(), address(pad));
        vm.prank(bob);
        vm.expectRevert(LaunchTokenFactory.OnlyLaunchpad.selector);
        f.create("Fake", "FAKE", 1e18);
    }

    function test_inboundMigrationStopsWithTheFreeze() public {
        // a coin arriving from a ledger, half delivered: no freeze is announced over it
        mig.setMigrationRoot(bytes32(uint256(1)), 1);
        uint256 sold = 100e18;
        uint256 quoteIn = Math.mulDiv(1.25 ether, sold, pad.VIRTUAL_TOKEN() - sold);
        LaunchpadBase.LedgerCoin memory coin = _ledgerCoin("Ledger Coin", "LEDG", sold);
        address[] memory holders = new address[](1);
        uint256[] memory balances = new uint256[](1);
        holders[0] = bob;
        balances[0] = sold / 2;
        vm.deal(address(this), quoteIn);
        address token = mig.migrateToken{value: quoteIn}(coin, holders, balances);
        assertEq(pad.migrationPending(token), sold / 2);
        assertEq(pad.pendingCoins(), 1);
        vm.expectRevert(LaunchpadBase.MigrationPending.selector);
        mig.announceFreeze(block.number + 5);
        // delivered whole, the freeze can come; announced, no coin arrives; landed, none is delivered
        holders[0] = carol;
        mig.migrateBalances(token, holders, balances);
        assertEq(pad.pendingCoins(), 0);
        mig.announceFreeze(block.number + 5);
        LaunchpadBase.LedgerCoin memory another = _ledgerCoin("Another", "ANOT", 0);
        vm.expectRevert(LaunchpadBase.CreationClosed.selector);
        mig.migrateToken(another, new address[](0), new uint256[](0));
        vm.roll(block.number + 5);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        mig.migrateBalances(token, holders, balances);
    }

    function test_claimCashbackWhileFrozen() public {
        vm.prank(alice);
        address h = pad.createTokenWithFees(
            "Holders Coin", "HOLD", 0, meta, address(quote), LaunchpadBase.FeeConfig(100, 100, 0, 10_000, 0, 0, 0)
        );
        _buy(bob, h, 5e8);
        uint256 bobBal = IERC20(h).balanceOf(bob);
        _buy(carol, h, 5e8);
        uint256 carolBal = IERC20(h).balanceOf(carol);
        // each buy's tax is 1% of 5 cbLTC (the launchpad's 0.5% apart), all of it the holders', spread
        // over who holds the coin once the buyer has it: bob alone after his buy, both after carol's
        uint256 acc = (5e6 * 1e30) / bobBal + (5e6 * 1e30) / (bobBal + carolBal);
        assertEq(pad.accCashbackPerShare(h), acc);
        uint256 owed = Math.mulDiv(bobBal, acc, 1e30);
        assertEq(pad.cashbackOf(h, bob), owed);
        assertGt(owed, 5e6, "his own buy's share and most of carol's");
        _freeze();
        vm.prank(bob);
        pad.claimCashback(h);
        assertEq(quote.balanceOf(bob), owed);
        uint256 carolOwed = pad.cashbackOf(h, carol);
        assertGt(carolOwed, 0);
        vm.prank(carol);
        pad.claimCashback(h);
        assertEq(quote.balanceOf(carol), carolOwed);
    }

    /// The pad's own arithmetic for a first buy of `first` on a fresh 30 cbLTC curve of a coin with
    /// no tax of its own (the launchpad's 0.5% alone), and the amount that then sells the curve out
    /// (rounded against the buyer).
    function _needAfter(uint256 first) internal view returns (uint256 need) {
        uint256 vEth = 30e8;
        uint256 vToken = pad.VIRTUAL_TOKEN();
        uint256 forCurve = first - (first * PLATFORM) / 10_000;
        uint256 out = vToken - (vEth * vToken) / (vEth + forCurve);
        uint256 x = vEth + forCurve;
        uint256 y = vToken - out;
        need = (x * y) / (y - (pad.CURVE_SUPPLY() - out)) - x + 1;
    }

    function test_graduatingBuyRoundingComesOffTheFee() public {
        // the wei the fee gross-up can add must never come out of the other coins' reserves. At 0.5% the
        // fee on the used part is curve * 50 / 9950 = curve / 199: find a first buy after which the amount
        // that sells the curve out is a multiple of 199, then buy exactly that with an ethIn of
        // (need / 199) * 200 - 1 — its fee is need / 199 - 1, so the curve gets exactly `need`, the case
        // where the fee grossed up (need / 199) plus the curve would be ethIn + 1
        pad.setMigrator(address(0)); // the reserve stays parked, so the pad's balance must cover it
        vm.prank(alice);
        address coin = pad.createToken("Round", "RND", 0, meta, address(quote), false);
        assertEq(_fees(coin).platformBps, PLATFORM);
        assertEq(_fees(coin).buyTaxBps, 0, "no tax of its own: the fee is the launchpad's alone");
        uint256 first = 1e8;
        while (_needAfter(first) % 199 != 0) first++;
        uint256 need = _needAfter(first);
        _buy(bob, coin, first);
        assertEq(_curve(coin).vEth, 30e8 + first - (first * PLATFORM) / 10_000, "the model matches the pad");
        uint256 ethIn = (need / 199) * 200 - 1;
        uint256 daveBefore = quote.balanceOf(dave);
        uint256 treasuryBefore = quote.balanceOf(treasury);
        _buy(dave, coin, ethIn);
        assertTrue(_curve(coin).graduated);
        assertEq(_curve(coin).realEth, (first - (first * PLATFORM) / 10_000) + need, "the curve got exactly `need`");
        assertEq(quote.balanceOf(dave), daveBefore, "nothing refunded: ethIn was spent whole");
        assertEq(quote.balanceOf(treasury) - treasuryBefore, need / 199 - 1, "the fee, the rounding wei off it");
        uint256 owed = _curve(coin).realEth + _curve(curveCoin).realEth + pad.creatorFees(alice, address(quote))
            + pad.burnPot(gradCoin) + pad.cashbackOf(gradCoin, dave);
        assertGe(quote.balanceOf(address(pad)), owed, "the pad covers every reserve, every pot and every claim");
    }

    // ------------------------------------------ the pool a migrated coin left

    /// §6: after migrateOut the pool is open on the way out and nothing on that way is taxed — the pad
    /// answers 0 and books nothing — so another provider's withdrawal returns exactly its share and a
    /// buy out of the pool delivers exactly the pair's output; nothing goes the other way.
    function test_otherProvidersLeaveThePoolAfterMigrateOut() public {
        (uint256 lp, uint256 unsold) = _daveAddsLiquidity();
        uint256 lpOurs = migrator.liquidity(gradCoin);
        uint256 lpTotal = MockV2Pair(gradPair).totalSupply();
        (uint256 rToken, uint256 rQuote) = _reserves(gradPair, gradCoin);
        uint256 pots = pad.burnPot(gradCoin) + pad.liquidityPot(gradCoin);
        uint256 supply = IERC20(gradCoin).totalSupply();
        _freeze();

        // frozen: the pool pays nobody out
        _expectSwapFrozen();

        // migrateOut takes our share and no more — what the snapshot counted as the pool — with the
        // coin's unspent pots; the coins taken as tax and never harvested are burned with the pool's
        // token side, so the supply left is what holders own
        (uint256 quoteOut, uint256 burned) = mig.migrateOut(gradCoin, cold);
        assertEq(pad.migratedPair(gradCoin), gradPair);
        assertEq(
            quoteOut,
            (rQuote * lpOurs) / lpTotal + pots,
            "our LP's share of the pool's quote and the pots, dave's stays"
        );
        assertEq(burned, (rToken * lpOurs) / lpTotal + unsold, "our LP's share of its coins, and the unsold tax");
        assertEq(IERC20(gradCoin).totalSupply(), supply - burned);
        assertEq(quote.balanceOf(cold), quoteOut);
        assertEq(_buckets(), 0, "the buckets are empty");

        // the pool is open on the way out, untaxed: the pad answers 0 and says nothing
        assertEq(pad.transferRate(gradCoin, gradPair, bob), 0);
        assertEq(pad.transferRate(gradCoin, gradPair, dave), 0);
        vm.recordLogs();
        _bobBuysOutOfThePool();
        _daveWithdraws(lp);
        (uint256 fromPad, uint256 taxedEvents) = _padLogs();
        assertEq(taxedEvents, 0, "no Taxed event");
        assertEq(fromPad, 0, "nothing from the pad at all");
        assertEq(_buckets(), 0, "the buckets stay empty");

        // but nothing goes the other way: not to a wallet, not into the pool
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(gradCoin, dave, gradPair);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(gradCoin, dave, bob);
        vm.startPrank(dave);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(bob, 1);
        vm.expectRevert(LaunchToken.Frozen.selector);
        IERC20(gradCoin).transfer(gradPair, 1);
        vm.stopPrank();
    }

    /// dave adds liquidity of his own to the graduated coin's pool, before the freeze. Liquidity added
    /// to a registered pool by anyone else is a trade: his coins pay the sell rate on the way in, the
    /// pair gets the net and mints him LP for that (the scarcer side), and the tax waits in the buckets.
    function _daveAddsLiquidity() internal returns (uint256 lp, uint256 unsold) {
        (uint256 rToken, uint256 rQuote) = _reserves(gradPair, gradCoin);
        uint256 supply = MockV2Pair(gradPair).totalSupply();
        uint256 sent = rToken / 10;
        uint256 tax = (sent * RATE) / 10_000;
        uint256 addQuote = rQuote / 10 + 1;
        quote.mint(dave, addQuote);
        vm.startPrank(dave);
        IERC20(gradCoin).transfer(gradPair, sent);
        quote.transfer(gradPair, addQuote);
        lp = MockV2Pair(gradPair).mint(dave);
        vm.stopPrank();
        assertEq(lp, ((sent - tax) * supply) / rToken, "LP for the net coins");
        (uint256 platform, uint256 pot) = _split(tax);
        assertEq(pad.taxTreasury(gradCoin), platform, "the launchpad's part of the tax on his add");
        assertEq(pad.taxPot(gradCoin), pot, "the coin's");
        (uint256 rToken2, uint256 rQuote2) = _reserves(gradPair, gradCoin);
        assertEq(rToken2, rToken + sent - tax, "the pool holds the net");
        assertEq(rQuote2, rQuote + addQuote);
        unsold = tax;
    }

    function _expectSwapFrozen() internal {
        (uint256 out0, uint256 out1) = _outs(gradPair, gradCoin, 1e18, true);
        vm.prank(bob);
        vm.expectRevert(LaunchToken.Frozen.selector);
        MockV2Pair(gradPair).swap(out0, out1, bob, "");
    }

    /// the pool is open on the way out: bob may buy the inert Base copy out of it, and gets exactly
    /// what the pair pays — no tax on the way
    function _bobBuysOutOfThePool() internal {
        assertEq(IERC20(gradCoin).balanceOf(bob), 0);
        (uint256 gross, uint256 tax) = _poolBuy(bob, 1e6);
        assertEq(tax, 0, "untaxed");
        assertEq(IERC20(gradCoin).balanceOf(bob), gross, "exactly the pair's output");
    }

    /// and dave withdraws his liquidity: exactly his share of both sides, nothing taken on the way
    function _daveWithdraws(uint256 lp) internal {
        uint256 ts = MockV2Pair(gradPair).totalSupply();
        uint256 coinShare = (lp * IERC20(gradCoin).balanceOf(gradPair)) / ts;
        uint256 quoteShare = (lp * quote.balanceOf(gradPair)) / ts;
        assertGt(coinShare, 0);
        assertGt(quoteShare, 0);
        uint256 daveCoins = IERC20(gradCoin).balanceOf(dave);
        uint256 daveQuote = quote.balanceOf(dave);
        vm.startPrank(dave);
        MockV2Pair(gradPair).transfer(gradPair, lp);
        (uint256 a0, uint256 a1) = MockV2Pair(gradPair).burn(dave);
        vm.stopPrank();
        (uint256 coinsOut, uint256 quoteOut) = MockV2Pair(gradPair).token0() == gradCoin ? (a0, a1) : (a1, a0);
        assertEq(coinsOut, coinShare, "the pair's own arithmetic");
        assertEq(quoteOut, quoteShare);
        assertEq(IERC20(gradCoin).balanceOf(dave) - daveCoins, coinShare, "his coins, whole: untaxed");
        assertEq(quote.balanceOf(dave) - daveQuote, quoteShare, "his cbLTC, whole");
        assertEq(MockV2Pair(gradPair).balanceOf(dave), 0);
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
        (uint256 quoteOut, uint256 burned) = mig.migrateOut(coin, cold);
        assertGe(quoteOut, (rQuote * 999) / 1000);
        assertEq(weth.balanceOf(cold), quoteOut, "the pool's WETH as WETH: no call into the bridge account");
        assertEq(cold.balance, 0);
        assertGt(burned, 0);
    }

    // ------------------------------------------------------------ flash swaps

    /// A flash swap cannot drive a harvest: inside the callback the pair is mid-swap, so the harvest's
    /// own swap on it trips Uniswap's lock (the mock copies it) — the harvest reverts LOCKED and the
    /// flash swap unwinds with it. Nothing the harvest did on the way (takeTax, the burn) survives.
    function test_flashSwapCannotHarvest() public {
        _fillBuckets();
        FlashBorrower borrower = new FlashBorrower(migrator, gradCoin, quote, MockV2Pair(gradPair));
        uint256 treasuryBucket = pad.taxTreasury(gradCoin);
        uint256 potBucket = pad.taxPot(gradCoin);
        uint256 supply = IERC20(gradCoin).totalSupply();
        uint256 burnedBefore = pad.burned(gradCoin);
        uint256 lp = migrator.liquidity(gradCoin);
        (uint256 rToken, uint256 rQuote) = _reserves(gradPair, gradCoin);

        vm.expectRevert(bytes("LOCKED"));
        borrower.flash(1e24, FlashBorrower.Then.Harvest, 0);

        assertEq(pad.taxTreasury(gradCoin), treasuryBucket, "nothing taken");
        assertEq(pad.taxPot(gradCoin), potBucket);
        assertEq(IERC20(gradCoin).totalSupply(), supply, "nothing burned");
        assertEq(pad.burned(gradCoin), burnedBefore);
        assertEq(migrator.liquidity(gradCoin), lp);
        assertEq(IERC20(gradCoin).balanceOf(address(borrower)), 0, "nothing borrowed");
        (uint256 rToken2, uint256 rQuote2) = _reserves(gradPair, gradCoin);
        assertEq(rToken2, rToken, "the pool as it was");
        assertEq(rQuote2, rQuote);

        // outside a swap the harvest is what it is: a slice of the untouched buckets
        uint256 slice = Math.min(treasuryBucket + potBucket, migrator.harvestCap(gradCoin));
        vm.prank(dave);
        (uint256 tokensIn,,) = migrator.harvest(gradCoin);
        assertEq(tokensIn, slice, "a slice, as if nothing had happened");
        assertEq(_buckets(), treasuryBucket + potBucket - slice);
    }

    /// The same borrower selling the borrowed coins back into the pair from inside the callback hits
    /// the same lock: the transfer into the pool goes through (taxed, like any sell) but the swap for
    /// the quote is refused, and the whole flash swap unwinds, tax included.
    function test_flashSwapCannotSellBackIntoThePair() public {
        _fillBuckets();
        FlashBorrower borrower = new FlashBorrower(migrator, gradCoin, quote, MockV2Pair(gradPair));
        uint256 buckets = _buckets();
        (uint256 rToken, uint256 rQuote) = _reserves(gradPair, gradCoin);

        vm.expectRevert(bytes("LOCKED"));
        borrower.flash(1e24, FlashBorrower.Then.SellBack, 0);

        assertEq(_buckets(), buckets, "the taxes of both legs unwound with the swap");
        assertEq(IERC20(gradCoin).balanceOf(address(borrower)), 0);
        (uint256 rToken2, uint256 rQuote2) = _reserves(gradPair, gradCoin);
        assertEq(rToken2, rToken);
        assertEq(rQuote2, rQuote);

        // the lock is the only obstacle: a flash swap that repays in quote lands, and its token leg
        // paid the buy rate like any buy out of the pool
        uint256 repay = _amountIn(1e24, rQuote, rToken);
        quote.mint(address(borrower), repay);
        uint256 tax = (1e24 * RATE) / 10_000;
        borrower.flash(1e24, FlashBorrower.Then.Repay, repay);
        assertEq(IERC20(gradCoin).balanceOf(address(borrower)), 1e24 - tax, "the coins, less the tax");
        assertEq(_buckets(), buckets + tax, "the tax, booked");
    }

    // ------------------------------------------- the harvest around the freeze

    /// §5/§6: a freeze announced puts the harvest in rush mode — no cap, no cooldown — so the buckets
    /// can be emptied before it lands; landed, the pad hands no coin out (takeTax reverts Frozen), no
    /// trade books a tax (transferRate refuses it before onTax could run), and the claims the harvests
    /// fed are paid as before.
    function test_rushHarvestEmptiesTheBucketsAndTheFreezeStopsIt() public {
        _fillBuckets();
        uint256 total = _buckets();
        uint256 cap = migrator.harvestCap(gradCoin);
        assertGt(total, cap);
        // no freeze announced: a slice a block
        vm.prank(dave);
        (uint256 tokensIn,,) = migrator.harvest(gradCoin);
        assertEq(tokensIn, cap, "capped");
        assertEq(_buckets(), total - cap);
        vm.prank(dave);
        vm.expectRevert(UniV2Migrator.HarvestCooldown.selector);
        migrator.harvest(gradCoin);

        // announced: the whole of both buckets, in the same block
        mig.announceFreeze(block.number + 5);
        total = _buckets();
        assertGt(total, migrator.harvestCap(gradCoin), "still more than a slice");
        uint256 creatorBefore = pad.creatorFees(alice, address(quote));
        uint256 daveBefore = pad.cashbackOf(gradCoin, dave);
        vm.prank(dave);
        (tokensIn,,) = migrator.harvest(gradCoin);
        assertEq(tokensIn, total, "the whole of both buckets, cap or no cap");
        assertEq(_buckets(), 0, "emptied");
        assertGt(pad.creatorFees(alice, address(quote)), creatorBefore, "the creator's share of the harvest, claimable");
        assertGt(pad.cashbackOf(gradCoin, dave), daveBefore, "the holders' share: dave's");

        // trading goes on until the block, taxed, and so do the harvests: again in the same block
        (, uint256 tax) = _poolBuy(carol, 5e8);
        assertGt(tax, 0);
        assertEq(_buckets(), tax);
        vm.prank(dave);
        (tokensIn,,) = migrator.harvest(gradCoin);
        assertEq(tokensIn, tax, "the last buy's tax, whole, in the same block");
        assertEq(_buckets(), 0);

        // the last trades before the freeze leave coins in the buckets
        _poolSell(carol, IERC20(gradCoin).balanceOf(carol) / 2);
        uint256 left = _buckets();
        assertGt(left, 0);
        vm.roll(block.number + 5);
        assertTrue(pad.frozen());

        // the pad hands nothing out, not even to its migrator...
        vm.prank(address(migrator));
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.takeTax(gradCoin, 0, 0, 0);
        // ...so a harvest, rush or not, fails there
        vm.prank(dave);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        migrator.harvest(gradCoin);
        assertEq(_buckets(), left, "untouched");
        // and no trade books a tax: the token asks the pad first and is refused, onTax is never reached
        (uint256 out0, uint256 out1) = _outs(gradPair, gradCoin, 1e18, true);
        vm.prank(carol);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        MockV2Pair(gradPair).swap(out0, out1, carol, "");
        vm.prank(carol);
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        IERC20(gradCoin).transfer(gradPair, 1e18);
        assertEq(_buckets(), left, "still untouched");

        // the claims the harvests fed are paid as before
        uint256 owedCarol = pad.cashbackOf(gradCoin, carol);
        assertGt(owedCarol, 0, "carol held the coin through the second rush harvest");
        uint256 carolQuote = quote.balanceOf(carol);
        vm.prank(carol);
        pad.claimCashback(gradCoin);
        assertEq(quote.balanceOf(carol) - carolQuote, owedCarol);
        uint256 owedDave = pad.cashbackOf(gradCoin, dave);
        uint256 daveQuote = quote.balanceOf(dave);
        vm.prank(dave);
        pad.claimCashback(gradCoin);
        assertEq(quote.balanceOf(dave) - daveQuote, owedDave);
        uint256 owedAlice = pad.creatorFees(alice, address(quote));
        assertGt(owedAlice, creatorBefore);
        vm.prank(alice);
        pad.claimCreatorFees(address(quote));
        assertEq(quote.balanceOf(alice), owedAlice);
    }

    /// cancelFreeze puts the pad back as it was: trades pay the fee and the tax into the buckets as
    /// before (they did while the freeze was announced too), and the harvest is a slice a block again.
    function test_cancelFreezeRestoresTaxedTrading() public {
        mig.announceFreeze(block.number + 5);
        (, uint256 tax1) = _poolBuy(carol, 5e8); // announced: taxed trading goes on
        assertGt(tax1, 0);
        assertEq(_buckets(), tax1);

        mig.cancelFreeze();
        assertEq(pad.freezeBlock(), 0);
        vm.roll(block.number + 10); // past the block it would have landed on: nothing happens
        assertFalse(pad.frozen());
        (, uint256 tax2) = _poolBuy(carol, 5e8);
        assertGt(tax2, 0);
        assertEq(_buckets(), tax1 + tax2, "the buckets grow again");
        _poolSell(carol, IERC20(gradCoin).balanceOf(carol) / 2);
        assertGt(_buckets(), tax1 + tax2);

        // and the harvest is capped and cooled down again
        _fillBuckets();
        uint256 total = _buckets();
        uint256 cap = migrator.harvestCap(gradCoin);
        assertGt(total, cap);
        vm.prank(dave);
        (uint256 tokensIn,,) = migrator.harvest(gradCoin);
        assertEq(tokensIn, cap, "a slice, not the whole");
        assertEq(_buckets(), total - cap);
        vm.prank(dave);
        vm.expectRevert(UniV2Migrator.HarvestCooldown.selector);
        migrator.harvest(gradCoin);
        vm.roll(block.number + 1);
        vm.prank(dave);
        (tokensIn,,) = migrator.harvest(gradCoin);
        assertGt(tokensIn, 0, "the next block");
    }
}
