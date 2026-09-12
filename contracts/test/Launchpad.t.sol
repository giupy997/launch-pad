// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {IDexMigrator} from "../src/interfaces/IDexMigrator.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

contract MockMigrator is IDexMigrator {
    address public lastToken;
    uint256 public lastTokenAmount;
    address public lastQuoteAsset;
    uint256 public lastQuoteAmount;
    uint256 public lastEthAmount;

    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable
    {
        lastToken = token;
        lastTokenAmount = tokenAmount;
        lastQuoteAsset = quoteAsset;
        lastQuoteAmount = quoteAmount;
        lastEthAmount = msg.value;
    }
}

contract MockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RevertingMigrator is IDexMigrator {
    function migrate(address, uint256, address, uint256) external payable {
        revert("dex down");
    }
}

contract LaunchpadTest is Test {
    Launchpad pad;
    MockMigrator migrator;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        pad = new Launchpad(treasury);
        migrator = new MockMigrator();
        pad.setMigrator(address(migrator));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _meta() internal pure returns (Launchpad.TokenMetadata memory) {
        return Launchpad.TokenMetadata({
            logoURI: "https://example.com/logo.png",
            website: "https://example.com",
            twitter: "https://x.com/test",
            telegram: "https://t.me/test",
            livestream: "",
            description: "A test coin"
        });
    }

    function _create() internal returns (address) {
        vm.prank(alice);
        return pad.createToken("Test Coin", "TEST", 0, _meta(), address(0), false);
    }

    /// Token launched in holders-rewards mode: the whole fee pot is cashback.
    function _createRewards() internal returns (address) {
        vm.prank(alice);
        return pad.createToken("Rewards Coin", "RWD", 0, _meta(), address(0), true);
    }

    // ------------------------------------------------------------- creation

    function test_createToken() public {
        address token = _create();
        assertEq(pad.tokenCount(), 1);
        assertEq(LaunchToken(token).balanceOf(address(pad)), pad.TOTAL_SUPPLY());
        assertEq(LaunchToken(token).name(), "Test Coin");
    }

    function test_createWithInitialBuy() public {
        vm.prank(alice);
        address token = pad.createToken{value: 0.1 ether}("Test", "TST", 0, _meta(), address(0), false);
        assertGt(LaunchToken(token).balanceOf(alice), 0);
    }

    function test_metadataStoredOnCreate() public {
        address token = _create();
        (string memory logo, string memory site,, string memory tg,,) = pad.tokenMetadata(token);
        assertEq(logo, "https://example.com/logo.png");
        assertEq(site, "https://example.com");
        assertEq(tg, "https://t.me/test");
    }

    function test_creatorCanUpdateMetadata() public {
        address token = _create();
        Launchpad.TokenMetadata memory m = _meta();
        m.logoURI = "ipfs://newlogo";
        vm.prank(alice);
        pad.updateMetadata(token, m);
        (string memory logo,,,,,) = pad.tokenMetadata(token);
        assertEq(logo, "ipfs://newlogo");
    }

    function test_nonCreatorCannotUpdateMetadata() public {
        address token = _create();
        vm.prank(bob);
        vm.expectRevert(Launchpad.NotCreator.selector);
        pad.updateMetadata(token, _meta());
    }

    // ------------------------------------------------------------- buying

    function test_buyTransfersTokensAndFee() public {
        address token = _create();
        uint256 quoted = pad.quoteBuy(token, 1 ether);

        vm.prank(bob);
        pad.buy{value: 1 ether}(token, quoted);

        assertEq(LaunchToken(token).balanceOf(bob), quoted);
        // 1% fee, creator mode: the whole 80% pot to alice, 20% treasury
        assertEq(treasury.balance, 0.002 ether);
        assertEq(pad.creatorFees(alice, address(0)), 0.008 ether);
        assertEq(pad.cashbackOf(token, bob), 0);
        (,, uint256 realEth,,,,) = pad.curves(token);
        assertEq(realEth, 0.99 ether);
    }

    function test_buyFeesToHoldersMode() public {
        address token = _createRewards();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        // 1% fee, holders mode: the whole 80% pot is cashback, 20% treasury
        assertEq(treasury.balance, 0.002 ether);
        assertEq(pad.creatorFees(alice, address(0)), 0);
        // bob is the only holder, so the whole cashback accrues to him
        assertApproxEqAbs(pad.cashbackOf(token, bob), 0.008 ether, 1e12);
        assertTrue(pad.feesToHolders(token));
    }

    function test_creatorFeeAccruesOnSellToo() public {
        address token = _create();
        vm.startPrank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();
        // fees from both legs accrued to alice, none lost
        assertGt(pad.creatorFees(alice, address(0)), 0.008 ether); // buy fee + sell fee
    }

    function test_claimCreatorFees() public {
        address token = _create();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        uint256 accrued = pad.creatorFees(alice, address(0));
        uint256 before = alice.balance;
        vm.prank(alice);
        pad.claimCreatorFees(address(0));

        assertEq(alice.balance - before, accrued);
        assertEq(pad.creatorFees(alice, address(0)), 0);
    }

    function test_claimRevertsWhenNothingAccrued() public {
        vm.prank(bob);
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        pad.claimCreatorFees(address(0));
    }

    function test_feeRedirectAccruesToRecipient() public {
        address token = _create();
        address vault = makeAddr("vault");
        vm.prank(alice);
        pad.setFeeRecipient(token, vault);

        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        assertEq(pad.creatorFees(vault, address(0)), 0.008 ether);
        assertEq(pad.creatorFees(alice, address(0)), 0);

        // vault can claim
        uint256 before = vault.balance;
        vm.prank(vault);
        pad.claimCreatorFees(address(0));
        assertEq(vault.balance - before, 0.008 ether);
    }

    function test_feeRedirectResetToCreator() public {
        address token = _create();
        address vault = makeAddr("vault");
        vm.startPrank(alice);
        pad.setFeeRecipient(token, vault);
        pad.setFeeRecipient(token, address(0));
        vm.stopPrank();

        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);
        assertEq(pad.creatorFees(alice, address(0)), 0.008 ether);
    }

    function test_onlyCreatorSetsFeeRecipient() public {
        address token = _create();
        vm.prank(bob);
        vm.expectRevert(Launchpad.NotCreator.selector);
        pad.setFeeRecipient(token, bob);
    }

    function test_livestreamStoredInMetadata() public {
        address token = _create();
        Launchpad.TokenMetadata memory m = _meta();
        m.livestream = "https://youtube.com/live/abc";
        vm.prank(alice);
        pad.updateMetadata(token, m);
        (,,,, string memory live,) = pad.tokenMetadata(token);
        assertEq(live, "https://youtube.com/live/abc");
    }

    function test_feeSplitCapAndOwner() public {
        vm.expectRevert(Launchpad.FeeTooHigh.selector);
        pad.setFeeSplit(8_000, 3_000); // sum > 100%
        pad.setFeeSplit(4_000, 4_000);
        assertEq(pad.creatorFeeShareBps(), 4_000);
        assertEq(pad.holderCashbackBps(), 4_000);
        vm.prank(alice);
        vm.expectRevert();
        pad.setFeeSplit(1_000, 1_000);
    }

    // ------------------------------------------------------------- cashback

    function test_cashbackClaim() public {
        address token = _createRewards();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        uint256 claimable = pad.cashbackOf(token, bob);
        assertApproxEqAbs(claimable, 0.008 ether, 1e12);

        uint256 before = bob.balance;
        vm.prank(bob);
        pad.claimCashback(token);
        assertEq(bob.balance - before, claimable);
        assertEq(pad.cashbackOf(token, bob), 0);

        vm.prank(bob);
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        pad.claimCashback(token);
    }

    function test_cashbackProRataAcrossHolders() public {
        address token = _createRewards();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0); // bob sole holder gets buy1 cashback

        address carol = makeAddr("carol");
        vm.deal(carol, 10 ether);
        vm.prank(carol);
        pad.buy{value: 1 ether}(token, 0); // buy2 cashback split pro-rata

        uint256 bobCb = pad.cashbackOf(token, bob);
        uint256 carolCb = pad.cashbackOf(token, carol);
        // bob: all of buy1 (0.008) + his share of buy2; carol: only her share of buy2
        assertGt(bobCb, 0.008 ether);
        assertGt(carolCb, 0);
        assertLt(carolCb, bobCb);
        // total distributed cashback matches 80% of both fees (0.016) within dust
        assertApproxEqAbs(bobCb + carolCb, 0.016 ether, 1e12);
    }

    function test_cashbackSurvivesPostGraduationTransfers() public {
        address token = _createRewards();
        _graduate(token);
        uint256 before = pad.cashbackOf(token, bob);
        assertGt(before, 0);

        // post-graduation transfer must not inflate the recipient's cashback
        vm.prank(bob);
        LaunchToken(token).transfer(alice, 100_000_000e18);
        assertEq(pad.cashbackOf(token, alice), 0);
        assertApproxEqAbs(pad.cashbackOf(token, bob), before, 1e12);
    }

    function test_priceIncreasesWithBuys() public {
        address token = _create();
        uint256 p0 = pad.currentPrice(token);
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 p1 = pad.currentPrice(token);
        assertGt(p1, p0);
    }

    function test_buySlippageReverts() public {
        address token = _create();
        uint256 quoted = pad.quoteBuy(token, 1 ether);
        vm.prank(bob);
        vm.expectRevert(Launchpad.Slippage.selector);
        pad.buy{value: 1 ether}(token, quoted + 1);
    }

    // ------------------------------------------------------------- selling

    function test_sellRoundTrip() public {
        address token = _create();
        vm.startPrank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 ethBefore = bob.balance;

        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();

        assertEq(LaunchToken(token).balanceOf(bob), 0);
        uint256 got = bob.balance - ethBefore;
        // Round trip returns slightly less than 0.99 ETH * 0.99 (two 1% fees).
        assertGt(got, 0.97 ether);
        assertLt(got, 1 ether);
    }

    function test_curveStateResetsAfterFullSell() public {
        address token = _create();
        vm.startPrank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();

        (,, uint256 realEth, uint256 sold,,,) = pad.curves(token);
        assertEq(sold, 0);
        // realEth keeps only rounding dust
        assertLt(realEth, 1e6);
    }

    // ------------------------------------------------------------- transfers

    function test_transfersBlockedBeforeGraduation() public {
        address token = _create();
        vm.startPrank(bob);
        pad.buy{value: 1 ether}(token, 0);
        vm.expectRevert(LaunchToken.NotGraduated.selector);
        LaunchToken(token).transfer(alice, 1e18);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- graduation

    function _graduate(address token) internal {
        // Way more ETH than the curve needs; the surplus must be refunded.
        vm.prank(bob);
        pad.buy{value: 50 ether}(token, 0);
    }

    function test_graduationOnCurveSellout() public {
        address token = _create();
        _graduate(token);

        (,,, uint256 sold, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(sold, pad.CURVE_SUPPLY());
        assertTrue(LaunchToken(token).graduated());
        // Bob paid only what the curve needed (~4 ETH + fee), rest refunded.
        assertGt(bob.balance, 45 ether);
    }

    function test_noTradingAfterGraduation() public {
        address token = _create();
        _graduate(token);

        vm.prank(alice);
        vm.expectRevert(Launchpad.AlreadyGraduated.selector);
        pad.buy{value: 1 ether}(token, 0);
    }

    function test_transfersFreeAfterGraduation() public {
        address token = _create();
        _graduate(token);
        vm.prank(bob);
        LaunchToken(token).transfer(alice, 1e18);
        assertEq(LaunchToken(token).balanceOf(alice), 1e18);
    }

    // ------------------------------------------------------------- migration

    function test_autoMigrationOnGraduation() public {
        address token = _create();
        _graduate(token); // graduating buy should migrate in the same tx
        assertEq(migrator.lastToken(), token);
        assertEq(migrator.lastTokenAmount(), pad.DEX_RESERVE());
        (,, uint256 realEthAfter,,,,) = pad.curves(token);
        assertEq(realEthAfter, 0);
    }

    function test_gracefulWhenAutoMigrationReverts() public {
        RevertingMigrator bad = new RevertingMigrator();
        pad.setMigrator(address(bad));
        address token = _create();
        _graduate(token); // must NOT revert even though the migrator does

        (,,,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        (,, uint256 raised,,,,) = pad.curves(token);
        assertGt(raised, 0); // funds still parked, manual path available

        pad.setMigrator(address(migrator));
        pad.migrate(token);
        assertEq(migrator.lastToken(), token);
    }

    function test_graduationWithoutMigratorParksFunds() public {
        pad.setMigrator(address(0));
        address token = _create();
        _graduate(token);
        (,,,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        (,, uint256 raised,,,,) = pad.curves(token);
        assertGt(raised, 0);
    }

    function test_migrateSendsReserveAndEth() public {
        pad.setMigrator(address(0)); // graduate without auto-migration
        address token = _create();
        _graduate(token);
        (,, uint256 raised,,,,) = pad.curves(token);
        pad.setMigrator(address(migrator));

        pad.migrate(token);

        assertEq(migrator.lastToken(), token);
        assertEq(migrator.lastTokenAmount(), pad.DEX_RESERVE());
        assertEq(migrator.lastEthAmount(), raised);
        assertEq(LaunchToken(token).balanceOf(address(migrator)), pad.DEX_RESERVE());
    }

    function test_migrateRevertsBeforeGraduation() public {
        address token = _create();
        vm.expectRevert(Launchpad.NotYetGraduated.selector);
        pad.migrate(token);
    }

    function test_migrateOnlyOnce() public {
        address token = _create();
        _graduate(token); // auto-migrated already
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        pad.migrate(token);
    }

    // ------------------------------------------------------------- admin

    function test_feeCapEnforced() public {
        vm.expectRevert(Launchpad.FeeTooHigh.selector);
        pad.setFeeBps(501);
    }

    function test_onlyOwnerSetsFee() public {
        vm.prank(alice);
        vm.expectRevert();
        pad.setFeeBps(200);
    }

    // ------------------------------------------------------------- fuzz

    /// Regression: buys that cross graduation must never revert on the
    /// refund math, whatever the rounding of the fee gross-up.
    function testFuzz_graduatingBuyNeverReverts(uint96 extra) public {
        extra = uint96(bound(extra, 0, 2 ether));
        address token = _create();

        // bring the curve close to graduation
        vm.prank(bob);
        pad.buy{value: 4 ether}(token, 0);
        (,,, uint256 sold, bool grad,,) = pad.curves(token);
        if (!grad) {
            // ETH needed to finish the curve, then cross it with a fuzzed surplus
            uint256 remaining = pad.CURVE_SUPPLY() - sold;
            (uint256 vEth, uint256 vToken,,,,,) = pad.curves(token);
            uint256 ethNeeded = (vEth * vToken) / (vToken - remaining) - vEth + 1;
            uint256 gross = (ethNeeded * 10_000) / 9_900 + uint256(extra);
            vm.deal(bob, gross);
            vm.prank(bob);
            pad.buy{value: gross}(token, 0);
        }
        (,,,, grad,,) = pad.curves(token);
        assertTrue(grad);
    }

    function testFuzz_buySellNeverProfits(uint96 ethIn) public {
        ethIn = uint96(bound(ethIn, 0.001 ether, 3 ether));
        address token = _create();

        vm.startPrank(bob);
        uint256 before = bob.balance;
        pad.buy{value: ethIn}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();

        assertLe(bob.balance, before); // fees make round trips strictly lossy
    }


    // ------------------------------------------------------- pre-markets

    function _createPreMarket() internal returns (address) {
        // owner is this test contract; 50M tokens of virtual reserve for
        // curves paired with the pre-market
        return pad.createPreMarket("OpenAI Pre-Market", "OPENAI", _meta(), 50_000_000e18);
    }

    function test_createPreMarketWiresEverything() public {
        address pre = _createPreMarket();
        assertTrue(LaunchToken(pre).transferable(), "transferable from day one");
        assertTrue(pad.feesToHolders(pre), "rewards mode");
        assertEq(pad.quoteVirtualReserve(pre), 50_000_000e18, "whitelisted as quote");
        assertEq(pad.tokenCount(), 1, "listed like any launch");
    }

    function test_onlyOwnerCreatesPreMarkets() public {
        vm.prank(alice);
        vm.expectRevert();
        pad.createPreMarket("X", "X", _meta(), 1e18);
    }

    function test_preMarketTransferableBeforeGraduation() public {
        address pre = _createPreMarket();
        vm.prank(bob);
        pad.buy{value: 1 ether}(pre, 0);

        address carol = makeAddr("carol");
        vm.prank(bob);
        LaunchToken(pre).transfer(carol, 1e18); // meme tokens would revert here
        assertEq(LaunchToken(pre).balanceOf(carol), 1e18);
    }

    function test_pairWithPreMarketEndToEnd() public {
        address pre = _createPreMarket();

        // bob stocks up on the pre-market from its own ETH curve
        vm.prank(bob);
        pad.buy{value: 2 ether}(pre, 0);
        uint256 preBal = LaunchToken(pre).balanceOf(bob);
        assertGt(preBal, 0);

        // alice launches a token paired with the (non-graduated) pre-market
        vm.prank(alice);
        address token = pad.createToken("OpenAI Fan", "OFAN", 0, _meta(), pre, false);

        vm.startPrank(bob);
        LaunchToken(pre).approve(address(pad), type(uint256).max);
        pad.buyWithQuote(token, 1_000_000e18, 0); // small paired buy first
        assertGt(LaunchToken(token).balanceOf(bob), 0, "paired buy works");

        // graduate the paired token (raise = 50M virtual * 3.2 = 160M pre,
        // bob holds ~640M from the 2 ETH buy; surplus is refunded in pre):
        // migration moves the pre-market quote to the migrator even though
        // the pre-market itself has not graduated
        pad.buyWithQuote(token, preBal - 1_000_000e18, 0);
        vm.stopPrank();

        (,,, uint256 sold, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "paired token graduated");
        assertEq(sold, pad.CURVE_SUPPLY());
        assertEq(migrator.lastToken(), token);
        assertEq(migrator.lastQuoteAsset(), pre);
        uint256 migBal = LaunchToken(pre).balanceOf(address(migrator));
        assertEq(migBal, migrator.lastQuoteAmount(), "quote delivered to migrator");

        // and the migrator can move it onward (e.g. into a DEX pool)
        vm.prank(address(migrator));
        LaunchToken(pre).transfer(alice, migBal);
        assertEq(LaunchToken(pre).balanceOf(alice), migBal);
    }

    // ------------------------------------------------------- quote assets

    function _createUsdCurve(bool feesToHolders) internal returns (address token, MockUSD usd) {
        usd = new MockUSD();
        pad.setQuoteAsset(address(usd), 4_000e6); // virtual reserve: 4000 mUSD
        vm.prank(alice);
        token = pad.createToken("Stock Coin", "STK", 0, _meta(), address(usd), feesToHolders);
        usd.mint(bob, 1_000_000e6);
        vm.prank(bob);
        usd.approve(address(pad), type(uint256).max);
    }

    function test_quoteCurveRequiresWhitelist() public {
        MockUSD usd = new MockUSD();
        vm.prank(alice);
        vm.expectRevert(Launchpad.QuoteAssetNotEnabled.selector);
        pad.createToken("X", "X", 0, _meta(), address(usd), false);
    }

    function test_quoteCurveBuySellAndFees() public {
        (address token, MockUSD usd) = _createUsdCurve(false);

        vm.prank(bob);
        pad.buyWithQuote(token, 1_000e6, 0);

        assertGt(LaunchToken(token).balanceOf(bob), 0);
        // 1% fee in mUSD, creator mode: 80% pot to alice, 20% treasury
        assertEq(pad.creatorFees(alice, address(usd)), 8e6);
        assertEq(usd.balanceOf(treasury), 2e6);
        assertEq(pad.cashbackOf(token, bob), 0);

        // native buy on a quote curve must revert
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(Launchpad.WrongPayment.selector);
        pad.buy{value: 1 ether}(token, 0);

        // sell pays out mUSD
        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 usdBefore = usd.balanceOf(bob);
        vm.startPrank(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();
        assertGt(usd.balanceOf(bob), usdBefore);

        // creator claim in mUSD
        vm.prank(alice);
        pad.claimCreatorFees(address(usd));
        assertGt(usd.balanceOf(alice), 0);
    }

    function test_quoteCurveHoldersMode() public {
        (address token, MockUSD usd) = _createUsdCurve(true);

        vm.prank(bob);
        pad.buyWithQuote(token, 1_000e6, 0);

        // 1% fee in mUSD, holders mode: 80% pot is cashback, 20% treasury
        assertEq(pad.creatorFees(alice, address(usd)), 0);
        assertEq(usd.balanceOf(treasury), 2e6);
        assertApproxEqAbs(pad.cashbackOf(token, bob), 8e6, 10);

        // cashback claim pays out mUSD
        uint256 before = usd.balanceOf(bob);
        vm.prank(bob);
        pad.claimCashback(token);
        assertGt(usd.balanceOf(bob), before);
    }

    function test_quoteCurveGraduatesAndMigratesInAsset() public {
        (address token, MockUSD usd) = _createUsdCurve(false);

        // curve raises ~ 4000 * 800/250 = 12800 mUSD; buy way past it
        vm.prank(bob);
        pad.buyWithQuote(token, 100_000e6, 0);

        (,,, uint256 sold, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(sold, pad.CURVE_SUPPLY());

        // auto-migration delivered the quote asset to the migrator
        assertEq(migrator.lastToken(), token);
        assertEq(migrator.lastQuoteAsset(), address(usd));
        assertGt(migrator.lastQuoteAmount(), 12_000e6);
        assertEq(usd.balanceOf(address(migrator)), migrator.lastQuoteAmount());
        (,, uint256 realEthAfter,,,,) = pad.curves(token);
        assertEq(realEthAfter, 0);
    }
}
