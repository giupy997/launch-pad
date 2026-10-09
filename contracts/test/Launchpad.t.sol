// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {IDexMigrator} from "../src/interfaces/IDexMigrator.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";

/// Records what it was handed and names no pool (address(0)): the launchpad
/// registers nothing, so nothing after graduation is a pool trade.
contract MockMigrator is IDexMigrator {
    address public lastToken;
    uint256 public lastTokenAmount;
    address public lastQuoteAsset;
    uint256 public lastQuoteAmount;
    uint256 public lastEthAmount;

    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable
        returns (address)
    {
        lastToken = token;
        lastTokenAmount = tokenAmount;
        lastQuoteAsset = quoteAsset;
        lastQuoteAmount = quoteAmount;
        lastEthAmount = msg.value;
        return address(0);
    }

    /// Moves coins it holds (the reserve it was handed): the migrator's own leg of a transfer.
    function send(address token, address to, uint256 amount) external {
        LaunchToken(token).transfer(to, amount);
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
    function migrate(address, uint256, address, uint256) external payable returns (address) {
        revert("dex down");
    }
}

/// The live surface of the v12 launchpad: creation, the curve, its fees, the
/// cashback, graduation and the hand-over to the migrator. The fee model
/// under test: the launchpad's 0.5% a side (platformBps, stamped at creation)
/// goes whole to the treasury; the coin's own tax is the only source of the
/// creator's and the holders' shares, split by its FeeConfig.
contract LaunchpadTest is Test {
    Launchpad pad;
    MockMigrator migrator;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    /// The launchpad's fee as deployed: 0.5% a side.
    uint256 constant PLATFORM = 50;
    /// The coin's own tax used throughout: 1% a side.
    uint16 constant TAX = 100;
    /// The cashback accumulator's precision (LaunchpadBase.ACC_PRECISION, internal).
    uint256 constant ACC = 1e30;

    function setUp() public {
        pad = new Launchpad(treasury);
        migrator = new MockMigrator();
        pad.setMigrator(address(migrator));
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function _meta() internal pure returns (LaunchpadBase.TokenMetadata memory) {
        return LaunchpadBase.TokenMetadata({
            logoURI: "https://example.com/logo.png",
            website: "https://example.com",
            twitter: "https://x.com/test",
            telegram: "https://t.me/test",
            livestream: "",
            description: "A test coin"
        });
    }

    /// A coin with no tax of its own: it pays the launchpad's fee alone, whole to the treasury.
    function _create() internal returns (address) {
        vm.prank(alice);
        return pad.createToken("Test Coin", "TEST", 0, _meta(), address(0), false);
    }

    /// A coin taxed 1% a side, the tax whole to its creator.
    function _createCreatorCoin() internal returns (address) {
        return _createTaxed(address(0), 10_000, 0);
    }

    /// A coin taxed 1% a side, the tax whole to its holders as cashback.
    function _createHoldersCoin() internal returns (address) {
        return _createTaxed(address(0), 0, 10_000);
    }

    function _createTaxed(address quoteAsset, uint16 creatorBps, uint16 holdersBps) internal returns (address) {
        vm.prank(alice);
        return pad.createTokenWithFees(
            "Taxed Coin",
            "TAX",
            0,
            _meta(),
            quoteAsset,
            LaunchpadBase.FeeConfig(TAX, TAX, creatorBps, holdersBps, 0, 0, 0)
        );
    }

    function _fees(address token) internal view returns (LaunchpadBase.FeeConfig memory f) {
        (f.buyTaxBps, f.sellTaxBps, f.creatorBps, f.holdersBps, f.burnBps, f.liquidityBps, f.platformBps) =
            pad.feeConfig(token);
    }

    /// v12's split of a curve trade at the rate `f` = platformBps + tax: the fee off the amount, the
    /// launchpad's part of it by platformBps (whole to the treasury), the rest the coin's pot.
    function _split(uint256 amount, uint256 f) internal pure returns (uint256 fee, uint256 platform, uint256 pot) {
        fee = (amount * f) / 10_000;
        platform = (fee * PLATFORM) / f;
        pot = fee - platform;
    }

    /// What a wallet holding `bal` of an eligible supply `eligible` can claim of a holders' share `pot`
    /// spread while its debt was zero: the accumulator floors the per-share increment and the entitlement.
    function _cashbackFloor(uint256 pot, uint256 eligible, uint256 bal) internal pure returns (uint256) {
        return (bal * ((pot * ACC) / eligible)) / ACC;
    }

    /// What the pad would quote: the curve's arithmetic on its reserves, the coin's rate off first.
    function _quoteBuy(address token, uint256 ethIn) internal view returns (uint256) {
        (uint256 vEth, uint256 vToken,, uint256 sold,,,) = pad.curves(token);
        LaunchpadBase.FeeConfig memory f = _fees(token);
        uint256 forCurve = ethIn - (ethIn * (uint256(f.platformBps) + f.buyTaxBps)) / pad.FEE_DENOMINATOR();
        uint256 out = vToken - (vEth * vToken) / (vEth + forCurve);
        uint256 remaining = pad.CURVE_SUPPLY() - sold;
        return out > remaining ? remaining : out;
    }

    /// What the curve pays for `tokensIn` before the fee: its arithmetic, capped at what it really holds.
    function _quoteSell(address token, uint256 tokensIn) internal view returns (uint256) {
        (uint256 vEth, uint256 vToken, uint256 realEth,,,,) = pad.curves(token);
        uint256 out = vEth - (vEth * vToken) / (vToken + tokensIn);
        return out > realEth ? realEth : out;
    }

    function _price(address token) internal view returns (uint256) {
        (uint256 vEth, uint256 vToken,,,,,) = pad.curves(token);
        return (vEth * 1e18) / vToken;
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

    /// The registry lists every coin, taxed or not, in creation order.
    function test_tokenCountAndAllTokensListCoins() public {
        assertEq(pad.tokenCount(), 0);
        address plain = _create();
        address taxed = _createCreatorCoin();
        assertEq(pad.tokenCount(), 2);
        assertEq(pad.allTokens(0), plain);
        assertEq(pad.allTokens(1), taxed);
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
        LaunchpadBase.TokenMetadata memory m = _meta();
        m.logoURI = "ipfs://newlogo";
        vm.prank(alice);
        pad.updateMetadata(token, m);
        (string memory logo,,,,,) = pad.tokenMetadata(token);
        assertEq(logo, "ipfs://newlogo");
    }

    function test_nonCreatorCannotUpdateMetadata() public {
        address token = _create();
        vm.prank(bob);
        vm.expectRevert(LaunchpadBase.NotCreator.selector);
        pad.updateMetadata(token, _meta());
    }

    /// A coin keeps the launchpad's fee as it stood when it was created: a
    /// later setFeeBps reaches coins created afterwards only, so a live coin's
    /// total rate is immutable, whatever the owner does. The platformBps the
    /// caller passes is overwritten.
    function test_platformBpsIsStampedAtCreation() public {
        assertEq(pad.feeBps(), 50, "v12 deploys at 0.5%");
        address early = _createCreatorCoin();
        assertEq(_fees(early).platformBps, 50);

        pad.setFeeBps(100);
        address late = _createCreatorCoin();
        assertEq(_fees(late).platformBps, 100, "a coin created after the change takes the new rate");
        assertEq(_fees(early).platformBps, 50, "a live coin keeps the rate it launched with");

        // a 1 ETH buy on each: 0.5% + 1% tax on the early coin, 1% + 1% tax on the late one
        vm.prank(bob);
        pad.buy{value: 1 ether}(early, 0);
        assertEq(treasury.balance, 0.005 ether, "50 bps to the treasury");
        assertEq(pad.creatorFees(alice, address(0)), 0.01 ether, "the 1% tax to the creator");
        (,, uint256 realEth,,,,) = pad.curves(early);
        assertEq(realEth, 0.985 ether);

        vm.prank(bob);
        pad.buy{value: 1 ether}(late, 0);
        assertEq(treasury.balance, 0.005 ether + 0.01 ether, "100 bps to the treasury");
        assertEq(pad.creatorFees(alice, address(0)), 0.02 ether, "the coin's own 1% is unchanged by the platform rate");
        (,, realEth,,,,) = pad.curves(late);
        assertEq(realEth, 0.98 ether);

        // whatever platformBps the creator wrote in the config, the pad stamps its own
        vm.prank(alice);
        address stamped = pad.createTokenWithFees(
            "Stamped", "STP", 0, _meta(), address(0), LaunchpadBase.FeeConfig(0, 0, 10_000, 0, 0, 0, 999)
        );
        assertEq(_fees(stamped).platformBps, 100, "the caller's platformBps is ignored");
    }

    /// The config is checked at creation (Fees.t.sol has the full matrix):
    /// the four shares add to 10,000 and each tax is at most MAX_TAX_BPS;
    /// the caps themselves are allowed.
    function test_createTokenWithFeesValidatesTheConfig() public {
        vm.startPrank(alice);
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        pad.createTokenWithFees(
            "A",
            "A",
            0,
            _meta(),
            address(0),
            LaunchpadBase.FeeConfig(TAX, TAX, 5000, 4999, 0, 0, 0) // shares 9,999
        );
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        pad.createTokenWithFees(
            "A",
            "A",
            0,
            _meta(),
            address(0),
            LaunchpadBase.FeeConfig(1001, 0, 10_000, 0, 0, 0, 0) // buy tax over the cap
        );
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        pad.createTokenWithFees(
            "A",
            "A",
            0,
            _meta(),
            address(0),
            LaunchpadBase.FeeConfig(0, 1001, 10_000, 0, 0, 0, 0) // sell tax over the cap
        );
        address max = pad.createTokenWithFees(
            "Max", "MAX", 0, _meta(), address(0), LaunchpadBase.FeeConfig(1000, 1000, 2500, 2500, 2500, 2500, 0)
        );
        vm.stopPrank();
        assertEq(pad.MAX_TAX_BPS(), 1000);
        LaunchpadBase.FeeConfig memory f = _fees(max);
        assertEq(f.buyTaxBps, 1000, "the cap itself is allowed");
        assertEq(f.sellTaxBps, 1000);
        assertEq(f.platformBps, 50);
    }

    // ------------------------------------------------------------- buying

    function test_buyTransfersTokensAndFee() public {
        address token = _createCreatorCoin();
        uint256 quoted = _quoteBuy(token, 1 ether);

        vm.prank(bob);
        pad.buy{value: 1 ether}(token, quoted);

        assertEq(LaunchToken(token).balanceOf(bob), quoted);
        // 0.5% launchpad fee + 1% tax = 1.5% off the top: the 0.5% whole to the treasury, the 1% whole to the creator
        (uint256 fee, uint256 platform, uint256 pot) = _split(1 ether, PLATFORM + TAX);
        assertEq(fee, 0.015 ether);
        assertEq(platform, 0.005 ether);
        assertEq(pot, 0.01 ether);
        assertEq(treasury.balance, 0.005 ether, "the platform fee, whole to the treasury");
        assertEq(pad.creatorFees(alice, address(0)), 0.01 ether, "the tax, whole to the creator");
        assertEq(pad.cashbackOf(token, bob), 0, "no holders share");
        (,, uint256 realEth,,,,) = pad.curves(token);
        assertEq(realEth, 0.985 ether, "the curve gets what is left after the fee");
    }

    /// A coin without a tax of its own pays the launchpad's 0.5% alone: the
    /// launch-time "fees to holders" choice is where a tax would go, and
    /// without one neither the creator nor the holders see anything.
    function test_untaxedCoinPaysThePlatformFeeAlone() public {
        address keep = _create();
        vm.prank(alice);
        address give = pad.createToken("Give", "GIVE", 0, _meta(), address(0), true);
        assertFalse(pad.feesToHolders(keep));
        assertTrue(pad.feesToHolders(give));

        vm.startPrank(bob);
        pad.buy{value: 1 ether}(keep, 0);
        pad.buy{value: 1 ether}(give, 0);
        vm.stopPrank();

        assertEq(treasury.balance, 0.01 ether, "0.5% of each buy");
        assertEq(pad.creatorFees(alice, address(0)), 0, "no tax, no creator share");
        assertEq(pad.cashbackOf(give, bob), 0, "no tax, no cashback");
        assertEq(pad.accCashbackPerShare(give), 0);
        (,, uint256 realEth,,,,) = pad.curves(keep);
        assertEq(realEth, 0.995 ether);
    }

    function test_buyFeesToHoldersMode() public {
        address token = _createHoldersCoin();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        // the 0.5% to the treasury; the 1% tax is cashback, spread over the eligible supply: bob alone
        assertEq(treasury.balance, 0.005 ether, "the platform fee, whole to the treasury");
        assertEq(pad.creatorFees(alice, address(0)), 0, "no creator share");
        uint256 bal = LaunchToken(token).balanceOf(bob);
        assertEq(pad.eligibleSupply(token), bal, "bob holds the whole eligible supply");
        assertEq(
            pad.cashbackOf(token, bob),
            _cashbackFloor(0.01 ether, bal, bal),
            "the whole tax, to the accumulator's rounding"
        );
        assertApproxEqAbs(pad.cashbackOf(token, bob), 0.01 ether, 1);
        assertTrue(pad.feesToHolders(token));
    }

    function test_creatorFeeAccruesOnSellToo() public {
        address token = _createCreatorCoin();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 out = _quoteSell(token, bal);
        assertEq(out, 0.985 ether, "the only buyer unwinds the whole curve: the reserve, exactly");
        (uint256 sellFee, uint256 sellPlatform, uint256 sellPot) = _split(out, PLATFORM + TAX);
        assertEq(sellFee, 0.014775 ether);
        assertEq(sellPlatform, 0.004925 ether);
        assertEq(sellPot, 0.00985 ether);

        uint256 ethBefore = bob.balance;
        vm.startPrank(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();

        assertEq(bob.balance - ethBefore, out - sellFee, "1.5% off what the curve pays");
        // the tax of both legs accrued to alice, none lost; the platform fee of both to the treasury
        assertEq(pad.creatorFees(alice, address(0)), 0.01 ether + sellPot, "buy tax + sell tax");
        assertEq(treasury.balance, 0.005 ether + sellPlatform, "buy fee + sell fee");
    }

    function test_claimCreatorFees() public {
        address token = _createCreatorCoin();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        assertEq(pad.creatorFees(alice, address(0)), 0.01 ether);
        uint256 before = alice.balance;
        vm.prank(alice);
        pad.claimCreatorFees(address(0));

        assertEq(alice.balance - before, 0.01 ether);
        assertEq(pad.creatorFees(alice, address(0)), 0);
    }

    function test_claimRevertsWhenNothingAccrued() public {
        vm.prank(bob);
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        pad.claimCreatorFees(address(0));
    }

    function test_feeRedirectAccruesToRecipient() public {
        address token = _createCreatorCoin();
        address vault = makeAddr("vault");
        vm.prank(alice);
        pad.setFeeRecipient(token, vault);

        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        assertEq(pad.creatorFees(vault, address(0)), 0.01 ether, "the whole tax to the recipient");
        assertEq(pad.creatorFees(alice, address(0)), 0);
        assertEq(treasury.balance, 0.005 ether, "the platform fee is not redirected");

        // vault can claim
        uint256 before = vault.balance;
        vm.prank(vault);
        pad.claimCreatorFees(address(0));
        assertEq(vault.balance - before, 0.01 ether);
    }

    function test_feeRedirectResetToCreator() public {
        address token = _createCreatorCoin();
        address vault = makeAddr("vault");
        vm.startPrank(alice);
        pad.setFeeRecipient(token, vault);
        pad.setFeeRecipient(token, address(0));
        vm.stopPrank();

        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);
        assertEq(pad.creatorFees(alice, address(0)), 0.01 ether);
        assertEq(pad.creatorFees(vault, address(0)), 0);
    }

    function test_onlyCreatorSetsFeeRecipient() public {
        address token = _create();
        vm.prank(bob);
        vm.expectRevert(LaunchpadBase.NotCreator.selector);
        pad.setFeeRecipient(token, bob);
    }

    function test_livestreamStoredInMetadata() public {
        address token = _create();
        LaunchpadBase.TokenMetadata memory m = _meta();
        m.livestream = "https://youtube.com/live/abc";
        vm.prank(alice);
        pad.updateMetadata(token, m);
        (,,,, string memory live,) = pad.tokenMetadata(token);
        assertEq(live, "https://youtube.com/live/abc");
    }

    // ------------------------------------------------------------- cashback

    function test_cashbackClaim() public {
        address token = _createHoldersCoin();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);

        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 claimable = pad.cashbackOf(token, bob);
        assertEq(claimable, _cashbackFloor(0.01 ether, bal, bal), "the 1% tax, to the accumulator's rounding");
        assertApproxEqAbs(claimable, 0.01 ether, 1);

        uint256 before = bob.balance;
        vm.prank(bob);
        pad.claimCashback(token);
        assertEq(bob.balance - before, claimable);
        assertEq(pad.cashbackOf(token, bob), 0);

        vm.prank(bob);
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        pad.claimCashback(token);
    }

    function test_cashbackProRataAcrossHolders() public {
        address token = _createHoldersCoin();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0); // bob, the sole holder, gets the whole first tax
        uint256 bobBal = LaunchToken(token).balanceOf(bob);

        address carol = makeAddr("carol");
        vm.deal(carol, 10 ether);
        vm.prank(carol);
        pad.buy{value: 1 ether}(token, 0); // the second tax is split pro rata
        uint256 carolBal = LaunchToken(token).balanceOf(carol);
        uint256 supply = bobBal + carolBal;
        assertEq(pad.eligibleSupply(token), supply);

        uint256 bobCb = pad.cashbackOf(token, bob);
        uint256 carolCb = pad.cashbackOf(token, carol);
        // bob: all of the first 0.01 ETH plus his share of the second; carol: her share of the second only.
        // The accumulator floors entitlements and ceils debts: within 2 wei of the exact pro-rata figure.
        assertApproxEqAbs(bobCb, 0.01 ether + (0.01 ether * bobBal) / supply, 2, "bob: buy1 whole + his share of buy2");
        assertApproxEqAbs(carolCb, (0.01 ether * carolBal) / supply, 2, "carol: her share of buy2");
        assertGt(carolCb, 0);
        assertLt(carolCb, bobCb);
        // the two taxes, 0.02 ETH in all, are spread whole (to dust) over the two holders
        assertApproxEqAbs(bobCb + carolCb, 0.02 ether, 4);
        assertEq(treasury.balance, 0.01 ether, "0.5% of each buy to the treasury");
        assertEq(pad.creatorFees(alice, address(0)), 0);
    }

    function test_cashbackSurvivesPostGraduationTransfers() public {
        address token = _createHoldersCoin();
        _graduate(token);
        uint256 before = pad.cashbackOf(token, bob);
        assertGt(before, 0, "the graduating buy's tax is bob's cashback");

        // no pool is registered (the mock names none), so the transfer is untaxed: the balances move whole.
        // One settlement per leg at the pre-transfer balances: the recipient earns nothing on the past and
        // the sender's claim is settled, not inflated or lost.
        vm.prank(bob);
        LaunchToken(token).transfer(alice, 100_000_000e18);
        assertEq(LaunchToken(token).balanceOf(alice), 100_000_000e18, "nothing taken on the way");
        assertEq(pad.cashbackOf(token, alice), 0);
        assertEq(pad.cashbackOf(token, bob), before, "settled at the old balance, re-anchored at the new: exact");
    }

    /// A holders share with no one to spread it over goes to the treasury, as
    /// _splitPot says: a holder who sells out leaves no eligible supply
    /// behind, so the sell's whole fee is the treasury's. What he earned while
    /// holding is settled by the transfer and stays his.
    function test_holdersShareGoesToTreasuryWithoutEligibleSupply() public {
        address token = _createHoldersCoin();
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 earned = pad.cashbackOf(token, bob);
        uint256 acc = pad.accCashbackPerShare(token);
        uint256 out = _quoteSell(token, bal);
        assertEq(out, 0.985 ether);
        (uint256 sellFee,,) = _split(out, PLATFORM + TAX);

        vm.startPrank(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();

        assertEq(pad.eligibleSupply(token), 0, "no one holds the coin");
        assertEq(
            treasury.balance,
            0.005 ether + sellFee,
            "the whole sell fee: the platform part and the orphaned holders share"
        );
        assertEq(pad.accCashbackPerShare(token), acc, "nothing was spread");
        assertEq(pad.cashbackOf(token, bob), earned, "what he earned while holding is settled, not lost");
        assertEq(address(pad).balance, 0.01 ether, "the pad keeps exactly the first buy's holders share");
        assertGe(address(pad).balance, earned, "and can pay the claim");
    }

    /// Below one whole token of eligible supply (MIN_ELIGIBLE_SUPPLY) the
    /// holders share goes to the treasury too: a dust-sized denominator would
    /// blow the accumulator up until every transfer overflowed.
    function test_holdersShareBelowOneWholeTokenGoesToTreasury() public {
        address token = _createHoldersCoin();
        uint256 tiny = 1e9; // one gwei buys about 0.83 of a token at the opening price
        uint256 quoted = _quoteBuy(token, tiny);
        assertLt(quoted, 1e18, "less than one whole token");

        vm.prank(bob);
        pad.buy{value: tiny}(token, 0);

        assertEq(LaunchToken(token).balanceOf(bob), quoted);
        assertEq(pad.eligibleSupply(token), quoted);
        (uint256 fee, uint256 platform, uint256 pot) = _split(tiny, PLATFORM + TAX);
        assertEq(fee, 15_000_000);
        assertEq(platform, 5_000_000);
        assertEq(pot, 10_000_000);
        assertEq(treasury.balance, fee, "the platform part and the holders share both");
        assertEq(pad.accCashbackPerShare(token), 0, "nothing spread");
        assertEq(pad.cashbackOf(token, bob), 0);
    }

    function test_priceIncreasesWithBuys() public {
        address token = _create();
        uint256 p0 = _price(token);
        vm.prank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 p1 = _price(token);
        assertGt(p1, p0);
    }

    function test_buySlippageReverts() public {
        address token = _createCreatorCoin();
        uint256 quoted = _quoteBuy(token, 1 ether);
        vm.prank(bob);
        vm.expectRevert(LaunchpadBase.Slippage.selector);
        pad.buy{value: 1 ether}(token, quoted + 1);
    }

    // ------------------------------------------------------------- selling

    function test_sellRoundTrip() public {
        address token = _create(); // no tax: the launchpad's 0.5% a side alone
        vm.startPrank(bob);
        pad.buy{value: 1 ether}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 ethBefore = bob.balance;

        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();

        assertEq(LaunchToken(token).balanceOf(bob), 0);
        uint256 got = bob.balance - ethBefore;
        // 0.5% off 1 ETH on the way in; the whole 0.995 ETH reserve unwound on the way out, 0.5% off that
        assertEq(got, 0.990025 ether);
        assertEq(treasury.balance, 0.005 ether + 0.004975 ether);
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
        // the sell is capped at what the curve holds, so the only buyer takes the reserve whole
        assertEq(realEth, 0);
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

    /// Without a registered pool (the mock names none) nothing after
    /// graduation is a pool trade: a wallet-to-wallet move of a coin taxed to
    /// the hilt pays nothing, and the legs touching the pad and the migrator
    /// never do. The balances move whole and no coin lands in the tax buckets.
    function test_walletTransfersUntaxedAfterGraduationWithoutAPool() public {
        vm.prank(alice);
        address token = pad.createTokenWithFees(
            "Max", "MAX", 0, _meta(), address(0), LaunchpadBase.FeeConfig(1000, 1000, 10_000, 0, 0, 0, 0)
        );
        assertEq(pad.transferRate(token, bob, alice), 0, "nothing on the curve");
        _graduate(token);
        assertEq(address(pad.graduatedVia(token)), address(migrator));
        assertFalse(pad.taxedPool(token, address(migrator)), "the mock named no pool");

        assertEq(pad.transferRate(token, bob, alice), 0, "wallet to wallet");
        assertEq(pad.transferRate(token, bob, address(pad)), 0, "into the pad");
        assertEq(pad.transferRate(token, address(pad), bob), 0, "out of the pad");
        assertEq(pad.transferRate(token, bob, address(migrator)), 0, "into the migrator");
        assertEq(pad.transferRate(token, address(migrator), bob), 0, "out of the migrator");

        uint256 bobBefore = LaunchToken(token).balanceOf(bob);
        uint256 padBefore = LaunchToken(token).balanceOf(address(pad));
        vm.prank(bob);
        LaunchToken(token).transfer(alice, 1e18);
        assertEq(LaunchToken(token).balanceOf(alice), 1e18, "whole");
        assertEq(LaunchToken(token).balanceOf(bob), bobBefore - 1e18, "exactly what he sent");

        // the migrator's own leg: the reserve it was handed moves whole too
        migrator.send(token, bob, 1e18);
        assertEq(LaunchToken(token).balanceOf(bob), bobBefore, "back to where he was");

        assertEq(LaunchToken(token).balanceOf(address(pad)), padBefore, "no coins taken as tax");
        assertEq(pad.taxTreasury(token), 0);
        assertEq(pad.taxPot(token), 0);
    }

    /// Only the pad's own coins can book a tax: a stranger — a wallet, or a
    /// coin of another launchpad — is refused before anything is written.
    function test_onTaxRejectsAnythingButThePadsCoins() public {
        address rogue = makeAddr("rogue");
        vm.prank(rogue);
        vm.expectRevert(LaunchpadBase.UnknownToken.selector);
        pad.onTax(bob, alice, 1e18);

        Launchpad other = new Launchpad(treasury);
        vm.prank(alice);
        address foreign = other.createToken("Other", "OTH", 0, _meta(), address(0), false);
        vm.prank(foreign);
        vm.expectRevert(LaunchpadBase.UnknownToken.selector);
        pad.onTax(bob, alice, 1e18);
        assertEq(pad.taxTreasury(foreign), 0);
        assertEq(pad.taxPot(foreign), 0);
    }

    /// One of the pad's own coins reporting a tax on a leg that touches no
    /// registered pool is refused too (BadHarvest): a tax only ever comes
    /// from a pool trade, so nothing is booked from thin air.
    function test_onTaxRejectsALegWithoutAPool() public {
        address token = _createCreatorCoin();
        _graduate(token);
        vm.prank(token);
        vm.expectRevert(LaunchpadBase.BadHarvest.selector);
        pad.onTax(bob, alice, 1e18);
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
        vm.expectRevert(LaunchpadBase.AlreadyGraduated.selector);
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
        // the pool opens at the closing price: the quote raised against as many coins as that
        // price says; the rest of the DEX reserve, the curve's virtual share, stays locked in the pad
        uint256 locked = pad.lockedAtGraduation(token);
        assertGt(locked, 0, "the virtual share stays");
        assertEq(migrator.lastTokenAmount() + locked, pad.DEX_RESERVE(), "pool and lock share the DEX reserve");
        assertEq(LaunchToken(token).balanceOf(address(pad)), locked, "locked in the pad");
        (uint256 vEth, uint256 vToken, uint256 realEthAfter,,,,) = pad.curves(token);
        assertEq(realEthAfter, 0);
        assertEq(migrator.lastTokenAmount(), (migrator.lastEthAmount() * vToken) / vEth, "coins at the closing price");
    }

    /// Graduation and migration are one piece: a migrator that reverts fails
    /// the buy that would cross the line, and the coin stays on its curve,
    /// its reserve untouched, until a working migrator is set. (The earlier
    /// try/catch left the coin graduated with its reserve waiting, the window
    /// the Base v9 pools were taken through.)
    function test_aRevertingMigratorFailsTheGraduatingBuy() public {
        RevertingMigrator bad = new RevertingMigrator();
        pad.setMigrator(address(bad));
        address token = _create();
        (,, uint256 before, uint256 soldBefore,,,) = pad.curves(token);
        vm.prank(bob);
        vm.expectRevert(bytes("dex down"));
        pad.buy{value: 50 ether}(token, 0);

        (,, uint256 raised, uint256 sold, bool graduated,,) = pad.curves(token);
        assertFalse(graduated, "not graduated without its pool");
        assertEq(raised, before);
        assertEq(sold, soldBefore);

        pad.setMigrator(address(migrator));
        _graduate(token);
        (,, raised,, graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(raised, 0, "migrated in the same transaction");
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
        assertEq(migrator.lastTokenAmount(), pad.DEX_RESERVE() - pad.lockedAtGraduation(token));
        assertEq(migrator.lastEthAmount(), raised);
        assertEq(LaunchToken(token).balanceOf(address(migrator)), pad.DEX_RESERVE() - pad.lockedAtGraduation(token));
    }

    function test_migrateRevertsBeforeGraduation() public {
        address token = _create();
        vm.expectRevert(LaunchpadBase.NotYetGraduated.selector);
        pad.migrate(token);
    }

    function test_migrateOnlyOnce() public {
        address token = _create();
        _graduate(token); // auto-migrated already
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        pad.migrate(token);
    }

    // ------------------------------------------------------------- admin

    function test_feeCapEnforced() public {
        assertEq(pad.MAX_FEE_BPS(), 500);
        vm.expectRevert(LaunchpadBase.FeeTooHigh.selector);
        pad.setFeeBps(501);
        pad.setFeeBps(500); // the cap itself is allowed
        assertEq(pad.feeBps(), 500);
    }

    function test_onlyOwnerSetsFee() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        pad.setFeeBps(200);
        assertEq(pad.feeBps(), 50);
    }

    // ------------------------------------------------------------- fuzz

    /// Regression: buys that cross graduation must never revert on the
    /// refund math, whatever the rounding of the fee gross-up — at any rate
    /// the coin's tax makes.
    function testFuzz_graduatingBuyNeverReverts(uint96 extra, uint16 tax) public {
        extra = uint96(bound(extra, 0, 2 ether));
        tax = uint16(bound(tax, 0, 1000));
        vm.prank(alice);
        address token = pad.createTokenWithFees(
            "Fuzz", "FZZ", 0, _meta(), address(0), LaunchpadBase.FeeConfig(tax, tax, 10_000, 0, 0, 0, 0)
        );
        uint256 f = PLATFORM + tax;

        // bring the curve close to graduation
        vm.prank(bob);
        pad.buy{value: 4 ether}(token, 0);
        (,,, uint256 sold, bool grad,,) = pad.curves(token);
        if (!grad) {
            // ETH needed to finish the curve, grossed up for the fee (rounded up), then a fuzzed surplus
            uint256 remaining = pad.CURVE_SUPPLY() - sold;
            (uint256 vEth, uint256 vToken,,,,,) = pad.curves(token);
            uint256 ethNeeded = (vEth * vToken) / (vToken - remaining) - vEth + 1;
            uint256 gross = (ethNeeded * 10_000 + (10_000 - f) - 1) / (10_000 - f) + uint256(extra);
            vm.deal(bob, gross);
            vm.prank(bob);
            pad.buy{value: gross}(token, 0);
        }
        (,,,, grad,,) = pad.curves(token);
        assertTrue(grad);
    }

    function testFuzz_buySellNeverProfits(uint96 ethIn, uint16 tax) public {
        ethIn = uint96(bound(ethIn, 0.001 ether, 3 ether));
        tax = uint16(bound(tax, 0, 1000));
        vm.prank(alice);
        address token = pad.createTokenWithFees(
            "Fuzz", "FZZ", 0, _meta(), address(0), LaunchpadBase.FeeConfig(tax, tax, 5000, 5000, 0, 0, 0)
        );

        vm.startPrank(bob);
        uint256 before = bob.balance;
        pad.buy{value: ethIn}(token, 0);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();

        assertLe(bob.balance, before); // fees make round trips strictly lossy
    }

    // ------------------------------------------------------- ERC-20 quote curves

    /// A taxed coin (1% a side) on an mUSD curve, the tax to the creator or to holders.
    function _createUsdCurve(bool feesToHolders) internal returns (address token, MockUSD usd) {
        usd = new MockUSD();
        pad.setQuoteAsset(address(usd), 4_000e6); // virtual reserve: 4000 mUSD
        token = _createTaxed(address(usd), feesToHolders ? 0 : 10_000, feesToHolders ? 10_000 : 0);
        usd.mint(bob, 1_000_000e6);
        vm.prank(bob);
        usd.approve(address(pad), type(uint256).max);
    }

    function test_quoteCurveRequiresWhitelist() public {
        MockUSD usd = new MockUSD();
        vm.prank(alice);
        vm.expectRevert(LaunchpadBase.QuoteAssetNotEnabled.selector);
        pad.createToken("X", "X", 0, _meta(), address(usd), false);
    }

    function test_quoteCurveBuySellAndFees() public {
        (address token, MockUSD usd) = _createUsdCurve(false);

        vm.prank(bob);
        pad.buyWithQuote(token, 1_000e6, 0);

        assertGt(LaunchToken(token).balanceOf(bob), 0);
        // 1.5% of 1000 mUSD: 5 mUSD (the 0.5%) to the treasury, 10 mUSD (the 1% tax) to the creator
        assertEq(pad.creatorFees(alice, address(usd)), 10e6);
        assertEq(usd.balanceOf(treasury), 5e6);
        assertEq(pad.cashbackOf(token, bob), 0);
        (,, uint256 realQuote,,,,) = pad.curves(token);
        assertEq(realQuote, 985e6);

        // native buy on a quote curve must revert
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        pad.buy{value: 1 ether}(token, 0);

        // sell pays out mUSD: 1.5% off what the curve pays, split the same way
        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 out = _quoteSell(token, bal);
        assertEq(out, 985e6, "the only buyer unwinds the whole curve");
        (uint256 sellFee, uint256 sellPlatform, uint256 sellPot) = _split(out, PLATFORM + TAX);
        assertEq(sellFee, 14_775_000);
        assertEq(sellPlatform, 4_925_000);
        assertEq(sellPot, 9_850_000);
        uint256 usdBefore = usd.balanceOf(bob);
        vm.startPrank(bob);
        LaunchToken(token).approve(address(pad), bal);
        pad.sell(token, bal, 0);
        vm.stopPrank();
        assertEq(usd.balanceOf(bob) - usdBefore, out - sellFee);
        assertEq(pad.creatorFees(alice, address(usd)), 10e6 + sellPot);
        assertEq(usd.balanceOf(treasury), 5e6 + sellPlatform);

        // creator claim in mUSD
        vm.prank(alice);
        pad.claimCreatorFees(address(usd));
        assertEq(usd.balanceOf(alice), 10e6 + sellPot);
        assertEq(pad.creatorFees(alice, address(usd)), 0);
    }

    function test_quoteCurveHoldersMode() public {
        (address token, MockUSD usd) = _createUsdCurve(true);

        vm.prank(bob);
        pad.buyWithQuote(token, 1_000e6, 0);

        // 1.5% of 1000 mUSD: 5 mUSD to the treasury, 10 mUSD of cashback for bob, the only holder
        assertEq(pad.creatorFees(alice, address(usd)), 0);
        assertEq(usd.balanceOf(treasury), 5e6);
        uint256 bal = LaunchToken(token).balanceOf(bob);
        uint256 claimable = pad.cashbackOf(token, bob);
        assertEq(claimable, _cashbackFloor(10e6, bal, bal), "the whole tax, to the accumulator's rounding");
        assertApproxEqAbs(claimable, 10e6, 1);

        // cashback claim pays out mUSD
        uint256 before = usd.balanceOf(bob);
        vm.prank(bob);
        pad.claimCashback(token);
        assertEq(usd.balanceOf(bob) - before, claimable);
        assertEq(pad.cashbackOf(token, bob), 0);
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
        (,, uint256 realQuoteAfter,,,,) = pad.curves(token);
        assertEq(realQuoteAfter, 0);
    }
}
