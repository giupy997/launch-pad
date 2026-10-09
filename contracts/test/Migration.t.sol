// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "openzeppelin-contracts/contracts/interfaces/draft-IERC6093.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {IDexMigrator} from "../src/interfaces/IDexMigrator.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";
import {MockWETH9, MockV2Factory, MockV2Pair, MockV2Router} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";

contract RecordingMigrator is IDexMigrator {
    address public lastToken;
    uint256 public lastTokenAmount;
    uint256 public lastEthAmount;

    function migrate(address token, uint256 tokenAmount, address, uint256) external payable returns (address) {
        lastToken = token;
        lastTokenAmount = tokenAmount;
        lastEthAmount = msg.value;
        return address(0);
    }
}

/// Migrating a coin from a frozen ledger — the Notus ledger on Litecoin
/// (8-decimal litoshi and coin units scaled by 1e10 for a native quote), or a
/// launchpad that froze elsewhere — the frozen state is re-created here and
/// trading continues at the same price, with the same holders, the coin's own
/// tax and the launchpad's fee as it stands the day it arrives. The
/// migration surface lives in the LaunchpadMigration module, reached through
/// the Launchpad's fallback: ILaunchpadMigration(address(pad)).
contract MigrationTest is Test {
    uint256 constant SCALE = 1e10;
    /// The launchpad's fee as deployed, stamped on every coin: 0.5% a side, whole to the treasury.
    uint256 constant PLATFORM = 50;
    /// The coins' own tax, as Notus's: 1% a side, the only source of the creator's and the holders' share.
    uint256 constant TAX = 100;
    uint256 constant LIMIT = 24_576; // EIP-170

    Launchpad pad;

    ILaunchpadMigration mig;
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address cold = makeAddr("cold"); // the account that bridges on a migration out

    // a plausible frozen ledger: 0.2 LTC virtual, 0.31483 LTC in the curve, 642.1M sold
    uint256 virtualQuote = 20_000_000 * SCALE;
    uint256 realQuote = 31_483_000 * SCALE;
    uint256[] bals = [uint256(244_740_000e8 * SCALE), 215_430_000e8 * SCALE, 181_930_000e8 * SCALE];
    address[] holders = [alice, bob, carol];
    uint256 sold = bals[0] + bals[1] + bals[2];

    bytes32 constant ROOT = bytes32(uint256(0x28bf69752873a3620128cb7ad5a7b2996f96650d0a165416fdc1980d5651721b));

    function setUp() public {
        pad = new Launchpad(treasury);
        mig = ILaunchpadMigration(address(pad));
        mig.setMigrationRoot(ROOT, 3_600_085);
        vm.deal(address(this), 100 ether);
        vm.deal(dave, 100 ether);
    }

    function _meta() internal pure returns (LaunchpadBase.TokenMetadata memory m) {
        m.logoURI = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
        m.description = "Migrated from Notus on Litecoin";
    }

    /// A Notus coin's fees: 1% a side, the pot whole to the holders (holders mode) or to the creator.
    function _fees(bool holdersMode) internal pure returns (LaunchpadBase.FeeConfig memory) {
        return LaunchpadBase.FeeConfig(
            uint16(TAX), uint16(TAX), holdersMode ? 0 : 10_000, holdersMode ? 10_000 : 0, 0, 0, 0
        );
    }

    /// A curve coin as the ledger left it, funded in the chain's own coin: the reserve the curve
    /// state implies (realQuote, with no pots) as quoteAmount, to be sent as msg.value.
    function _coin(
        string memory name,
        string memory symbol,
        address creator_,
        bool holdersMode,
        uint256 vq,
        uint256 sold_
    ) internal view returns (LaunchpadBase.LedgerCoin memory) {
        return LaunchpadBase.LedgerCoin({
            name: name,
            symbol: symbol,
            meta: _meta(),
            creator: creator_,
            feeRecipient: address(0),
            fees: _fees(holdersMode),
            quoteAsset: address(0),
            quoteAmount: realQuote,
            virtualQuote: vq,
            sold: sold_,
            burned: 0,
            poolToken: 0,
            burnPot: 0,
            liquidityPot: 0
        });
    }

    function _migrate(bool holdersMode) internal returns (address) {
        return mig.migrateToken{value: realQuote}(
            _coin("Lite Cat", "LCAT", creator, holdersMode, virtualQuote, sold), holders, bals
        );
    }

    /// The curve's own arithmetic for a buy of `ethIn` at the rate `f`: what the fee is, the
    /// launchpad's part of it, and the tokens the rest buys.
    function _quoteBuy(address token, uint256 ethIn, uint256 f)
        internal
        view
        returns (uint256 fee, uint256 platform, uint256 tokensOut)
    {
        fee = (ethIn * f) / pad.FEE_DENOMINATOR();
        platform = (fee * PLATFORM) / f;
        (uint256 vEth, uint256 vToken,,,,,) = pad.curves(token);
        tokensOut = vToken - (vEth * vToken) / (vEth + ethIn - fee);
    }

    /// The curve's own arithmetic for a sell of `tokensIn` at the rate `f`.
    function _quoteSell(address token, uint256 tokensIn, uint256 f)
        internal
        view
        returns (uint256 out, uint256 fee, uint256 platform)
    {
        (uint256 vEth, uint256 vToken,,,,,) = pad.curves(token);
        out = vEth - (vEth * vToken) / (vToken + tokensIn);
        fee = (out * f) / pad.FEE_DENOMINATOR();
        platform = (fee * PLATFORM) / f;
    }

    /// A Uniswap v2 stack on this pad: the migrator every graduation seeds a token/WETH pool through.
    function _uniV2() internal returns (UniV2Migrator migrator, MockWETH9 weth, MockV2Factory factory) {
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        pad.setMigrator(address(migrator));
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

    /// A sell on a native pool, as a router does it: the coins to the pair — taxed on the way, so the
    /// pair gets the net — and the WETH the net buys swapped out to `who`.
    function _poolSell(address who, address token, address pair, uint256 tokensIn) internal {
        uint256 net = tokensIn - (tokensIn * pad.transferRate(token, who, pair)) / 10_000;
        (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
        (uint256 out0, uint256 out1) = _outs(pair, token, _amountOut(net, rToken, rQuote), false);
        vm.startPrank(who);
        IERC20(token).transfer(pair, tokensIn);
        MockV2Pair(pair).swap(out0, out1, who, "");
        vm.stopPrank();
    }

    /// A buy on a native pool: `who`'s coin wrapped and sent to the pair, the coins swapped out to
    /// `who` — taxed on the way out, the tax left with the pad.
    function _poolBuy(address who, address token, address pair, MockWETH9 weth, uint256 quoteIn) internal {
        (uint256 rToken, uint256 rQuote) = _reservesOf(pair, token);
        (uint256 out0, uint256 out1) = _outs(pair, token, _amountOut(quoteIn, rQuote, rToken), true);
        vm.startPrank(who);
        weth.deposit{value: quoteIn}();
        weth.transfer(pair, quoteIn);
        MockV2Pair(pair).swap(out0, out1, who, "");
        vm.stopPrank();
    }

    function _ownableError(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who);
    }

    // ------------------------------------------------------------ the state

    function test_stateAndBalancesMatchTheLedger() public {
        address token = _migrate(false);
        (uint256 vEth, uint256 vToken, uint256 realEth, uint256 soldNow, bool graduated, address c, address quote) =
            pad.curves(token);
        assertEq(vEth, virtualQuote + realQuote);
        assertEq(vToken, pad.VIRTUAL_TOKEN() - sold);
        assertEq(realEth, realQuote);
        assertEq(soldNow, sold);
        assertFalse(graduated);
        assertEq(c, creator);
        assertEq(quote, address(0));
        assertEq(IERC20(token).balanceOf(alice), bals[0]);
        assertEq(IERC20(token).balanceOf(bob), bals[1]);
        assertEq(IERC20(token).balanceOf(carol), bals[2]);
        assertEq(IERC20(token).balanceOf(address(pad)), pad.TOTAL_SUPPLY() - sold);
        assertEq(pad.migrationPending(token), 0);
        assertEq(pad.eligibleSupply(token), sold, "holders are cashback-eligible from the first block");
        assertEq(address(pad).balance, realQuote);
        (uint256 cv, uint256 ct,,,,,) = pad.curves(token);
        assertEq((cv * 1e18) / ct, (vEth * 1e18) / vToken);
        (string memory logo,,,,, string memory description) = pad.tokenMetadata(token);
        assertEq(logo, "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
        assertEq(description, "Migrated from Notus on Litecoin");
        assertEq(pad.tokenCount(), 1);
        _assertNotusFees(token, false);
    }

    /// The coin's own tax came along, and the launchpad's fee is this launchpad's.
    function _assertNotusFees(address token, bool holdersMode) internal view {
        (uint16 buyTax, uint16 sellTax, uint16 creatorBps, uint16 holdersBps, uint16 burnBps, uint16 liqBps, uint16 platformBps) =
            pad.feeConfig(token);
        assertEq(buyTax, TAX);
        assertEq(sellTax, TAX);
        assertEq(creatorBps, holdersMode ? 0 : 10_000, "the pot whole to the creator, or to the holders");
        assertEq(holdersBps, holdersMode ? 10_000 : 0);
        assertEq(uint256(burnBps) + liqBps, 0);
        assertEq(platformBps, PLATFORM);
    }

    function test_tradingContinuesAtTheLedgerPrice() public {
        address token = _migrate(false);
        uint256 f = PLATFORM + TAX; // the launchpad's fee and the coin's tax, on every trade
        // the same constant-product arithmetic the ledger used, on the migrated reserves
        uint256 ethIn = 0.01 ether;
        (uint256 fee, uint256 platform, uint256 expected) = _quoteBuy(token, ethIn, f);
        {
            uint256 k = (virtualQuote + realQuote) * (pad.VIRTUAL_TOKEN() - sold);
            assertEq(expected, (pad.VIRTUAL_TOKEN() - sold) - k / (virtualQuote + realQuote + ethIn - fee));
        }
        vm.prank(dave);
        pad.buy{value: ethIn}(token, expected);
        assertEq(IERC20(token).balanceOf(dave), expected);
        assertEq(fee, (ethIn * 150) / 10_000, "1.5% in all: 0.5% the launchpad's, 1% the coin's");
        assertEq(treasury.balance, platform, "the launchpad's 0.5%, whole, to the treasury");
        assertEq(pad.creatorFees(creator, address(0)), fee - platform, "creator mode: the coin's 1% tax, whole, to the creator");
        assertEq(pad.creatorFees(creator, address(0)), ethIn / 100);

        // a migrated holder sells into the migrated reserve
        _aliceSellsHalf(token, f, realQuote + ethIn - fee, platform, fee - platform);
    }

    /// alice sells half her migrated balance at the rate `f`; the reserve, the treasury and the
    /// creator's claim move by exactly the curve's figures from where they stood.
    function _aliceSellsHalf(address token, uint256 f, uint256 reserveBefore, uint256 treasuryBefore, uint256 creatorBefore)
        internal
    {
        uint256 half = bals[0] / 2;
        (uint256 out, uint256 sellFee, uint256 sellPlatform) = _quoteSell(token, half, f);
        vm.startPrank(alice);
        IERC20(token).approve(address(pad), half);
        pad.sell(token, half, out - sellFee);
        vm.stopPrank();
        assertEq(alice.balance, out - sellFee);
        assertEq(_reserve(token), reserveBefore - out, "reserve moved by the buy and the sell");
        assertEq(treasury.balance, treasuryBefore + sellPlatform, "the launchpad's fee on the sell too");
        assertEq(pad.creatorFees(creator, address(0)), creatorBefore + (sellFee - sellPlatform));
        assertEq(address(pad).balance, _reserve(token) + pad.creatorFees(creator, address(0)), "the pad holds the reserve and the creator's claim, nothing less");
    }

    function _reserve(address token) internal view returns (uint256 realEth) {
        (,, realEth,,,,) = pad.curves(token);
    }

    function test_tradingWaitsUntilEveryHolderIsServed() public {
        address[] memory first = new address[](1);
        uint256[] memory firstBal = new uint256[](1);
        first[0] = alice;
        firstBal[0] = bals[0];
        address token = mig.migrateToken{value: realQuote}(
            _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), first, firstBal
        );
        assertEq(pad.migrationPending(token), bals[1] + bals[2]);

        vm.prank(dave);
        vm.expectRevert(LaunchpadBase.MigrationPending.selector);
        pad.buy{value: 0.01 ether}(token, 0);
        vm.prank(alice);
        vm.expectRevert(LaunchpadBase.MigrationPending.selector);
        pad.sell(token, 1e18, 0);

        address[] memory rest = new address[](2);
        uint256[] memory restBal = new uint256[](2);
        rest[0] = bob;
        rest[1] = carol;
        restBal[0] = bals[1];
        restBal[1] = bals[2] + 1; // one unit more than the ledger sold
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateBalances(token, rest, restBal);

        restBal[1] = bals[2];
        mig.migrateBalances(token, rest, restBal);
        assertEq(pad.migrationPending(token), 0);
        assertEq(IERC20(token).balanceOf(carol), bals[2]);

        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateBalances(token, rest, restBal); // nothing left to deliver

        vm.prank(dave);
        pad.buy{value: 0.01 ether}(token, 0);
        assertGt(IERC20(token).balanceOf(dave), 0);
    }

    function test_onlyTheOwnerMigrates() public {
        // no operator named: the owner alone
        assertEq(pad.migrationOperator(), address(0));
        vm.prank(dave);
        vm.expectRevert(LaunchpadBase.NotOperator.selector);
        mig.migrateToken{value: realQuote}(_coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), holders, bals);
    }

    function test_rejectsStateTheLedgerCouldNotHaveProduced() public {
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: realQuote}(_coin("X", "X", address(0), false, virtualQuote, sold), holders, bals);
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: realQuote}(_coin("X", "X", creator, false, 0, sold), holders, bals);
        uint256 tooMuch = pad.CURVE_SUPPLY() + 1; // (an external call inside the arguments would eat the expectRevert)
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: realQuote}(_coin("X", "X", creator, false, virtualQuote, tooMuch), holders, bals);
        uint256[] memory short = new uint256[](2);
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: realQuote}(_coin("X", "X", creator, false, virtualQuote, sold), holders, short);
        // balances that exceed what the ledger sold
        uint256[] memory tooMany = new uint256[](3);
        tooMany[0] = sold;
        tooMany[1] = 1;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: realQuote}(_coin("X", "X", creator, false, virtualQuote, sold), holders, tooMany);
        // more burned than ever sold
        LaunchpadBase.LedgerCoin memory c = _coin("X", "X", creator, false, virtualQuote, sold);
        c.burned = sold + 1;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: realQuote}(c, holders, bals);
        // pots larger than the quote delivered
        c = _coin("X", "X", creator, false, virtualQuote, sold);
        c.burnPot = realQuote + 1;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: realQuote}(c, holders, bals);
        // a fee configuration no coin could have launched with: a tax over the cap, shares that do not add up
        c = _coin("X", "X", creator, false, virtualQuote, sold);
        c.fees.buyTaxBps = uint16(pad.MAX_TAX_BPS() + 1);
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        mig.migrateToken{value: realQuote}(c, holders, bals);
        c = _coin("X", "X", creator, false, virtualQuote, sold);
        c.fees.creatorBps = 9_999;
        vm.expectRevert(LaunchpadBase.BadFeeConfig.selector);
        mig.migrateToken{value: realQuote}(c, holders, bals);
        // an untraded coin carries no reserve and no holders
        address[] memory none = new address[](0);
        uint256[] memory noneBal = new uint256[](0);
        c = _coin("X", "X", creator, false, virtualQuote, 0);
        c.quoteAmount = 1;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: 1}(c, none, noneBal);
        c = _coin("X", "X", creator, false, virtualQuote, 0);
        c.quoteAmount = 0;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken(c, holders, bals);
        c = _coin("Empty", "EMPTY", creator, false, virtualQuote, 0);
        c.quoteAmount = 0;
        address empty = mig.migrateToken(c, none, noneBal);
        assertEq(pad.migrationPending(empty), 0);
        vm.prank(dave);
        pad.buy{value: 0.01 ether}(empty, 0);
        assertGt(IERC20(empty).balanceOf(dave), 0, "an untraded coin opens for trading at once");
    }

    function test_soldOutLedgerCurveGraduatesOnceDelivered() public {
        RecordingMigrator migrator = new RecordingMigrator();
        pad.setMigrator(address(migrator));
        uint256[] memory full = new uint256[](3);
        full[0] = pad.CURVE_SUPPLY() / 2;
        full[1] = pad.CURVE_SUPPLY() / 4;
        full[2] = pad.CURVE_SUPPLY() - full[0] - full[1];
        uint256 raised = 0.64 ether; // ~3.2x the virtual reserve, like a completed ledger curve
        LaunchpadBase.LedgerCoin memory c = _coin("Done", "DONE", creator, true, virtualQuote, pad.CURVE_SUPPLY());
        c.quoteAmount = raised;
        address token = mig.migrateToken{value: raised}(c, holders, full);
        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertTrue(LaunchToken(token).graduated());
        assertEq(realEth, 0, "the reserve went to the DEX");
        assertEq(migrator.lastToken(), token);
        // a curve that sold out here opens its pool at the closing price: the pool's share of
        // the reserve goes, the curve's virtual share stays locked in the pad
        assertEq(migrator.lastTokenAmount(), pad.DEX_RESERVE() - pad.lockedAtGraduation(token));
        assertGt(pad.lockedAtGraduation(token), 0);
        assertEq(migrator.lastEthAmount(), raised);
        // graduated: holders can now transfer freely
        vm.prank(alice);
        IERC20(token).transfer(dave, 1e18);
        assertEq(IERC20(token).balanceOf(dave), 1e18);
    }

    /// A coin that sold its 800M out on the ledger traded on there in a locked
    /// pool (the 200M reserve against the LTC raised); it arrives with that
    /// pool as it stood: holders own TOTAL - poolToken, the pool goes to the DEX.
    function test_graduatedLedgerCoinMigratesItsPool() public {
        RecordingMigrator migrator = new RecordingMigrator();
        pad.setMigrator(address(migrator));
        uint256 poolToken = 150_000_000e18; // buys through the pool took 50M out of the 200M
        uint256 poolQuote = 1.2 ether;
        uint256 owned = pad.TOTAL_SUPPLY() - poolToken;
        uint256[] memory full = new uint256[](3);
        full[0] = 500_000_000e18;
        full[1] = 300_000_000e18;
        full[2] = owned - full[0] - full[1];
        LaunchpadBase.LedgerCoin memory c = _coin("Pooled", "POOL", creator, true, virtualQuote, owned);
        c.poolToken = poolToken;
        c.quoteAmount = poolQuote;
        address token = mig.migrateToken{value: poolQuote}(c, holders, full);

        (, uint256 vToken, uint256 realEth, uint256 soldNow, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "the curve was complete on the ledger");
        assertTrue(LaunchToken(token).graduated());
        assertEq(soldNow, pad.CURVE_SUPPLY());
        assertEq(vToken, pad.VIRTUAL_TOKEN() - pad.CURVE_SUPPLY());
        assertEq(realEth, 0, "the pool went to the DEX");
        assertEq(pad.migratedPoolTokens(token), poolToken);
        assertEq(migrator.lastToken(), token);
        assertEq(migrator.lastTokenAmount(), poolToken, "the pool's token side, not the fixed 200M");
        assertEq(migrator.lastEthAmount(), poolQuote, "the pool's LTC side");
        assertEq(IERC20(token).balanceOf(address(pad)), 0, "nothing stranded: holders + pool = supply");
        assertEq(IERC20(token).balanceOf(alice), full[0]);
        assertEq(IERC20(token).balanceOf(carol), full[2]);
        assertEq(pad.migrationPending(token), 0);
        vm.prank(alice);
        IERC20(token).transfer(dave, 1e18);
        assertEq(IERC20(token).balanceOf(dave), 1e18);

        // holders and pool must add up to the supply, and a pool has a quote side
        c = _coin("Pooled", "POOL2", creator, true, virtualQuote, owned);
        c.poolToken = poolToken + 1;
        c.quoteAmount = poolQuote;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken{value: poolQuote}(c, holders, full);
        c.poolToken = poolToken;
        c.quoteAmount = 0;
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        mig.migrateToken(c, holders, full);
    }

    function test_holdersModeKeepsPayingMigratedHolders() public {
        address token = _migrate(true);
        uint256 ethIn = 0.05 ether; // small enough not to sell the curve out
        (uint256 fee, uint256 platform,) = _quoteBuy(token, ethIn, PLATFORM + TAX);
        vm.prank(dave);
        pad.buy{value: ethIn}(token, 0);
        // the launchpad's 0.5% goes to the treasury; the coin's 1% is the pot, whole to the holders
        uint256 pot = fee - platform;
        assertEq(platform, (ethIn * PLATFORM) / 10_000);
        assertEq(pot, (ethIn * TAX) / 10_000);
        assertEq(treasury.balance, platform, "the launchpad's fee alone reaches the treasury");
        uint256 total = pad.cashbackOf(token, alice) + pad.cashbackOf(token, bob) + pad.cashbackOf(token, carol)
            + pad.cashbackOf(token, dave);
        assertGt(pad.cashbackOf(token, alice), pad.cashbackOf(token, carol), "pro-rata to the migrated balances");
        assertLe(total, pot);
        assertGt(total, pot - 1e6, "all but rounding dust reaches the holders");
        assertEq(pad.creatorFees(creator, address(0)), 0, "nothing to the creator in holders mode");
        vm.prank(alice);
        pad.claimCashback(token);
        assertGt(alice.balance, 0);
    }

    function test_uniV2MigratorSeedsAndLocksThePool() public {
        (UniV2Migrator migrator, MockWETH9 weth, MockV2Factory factory) = _uniV2();
        uint256[] memory full = new uint256[](3);
        full[0] = pad.CURVE_SUPPLY() / 2;
        full[1] = pad.CURVE_SUPPLY() / 4;
        full[2] = pad.CURVE_SUPPLY() - full[0] - full[1];
        LaunchpadBase.LedgerCoin memory c = _coin("Done", "DONE", creator, false, virtualQuote, pad.CURVE_SUPPLY());
        c.quoteAmount = 0.64 ether;
        address token = mig.migrateToken{value: 0.64 ether}(c, holders, full);
        address pair = factory.getPair(token, address(weth));
        assertTrue(pair != address(0), "the pair was created");
        assertEq(IERC20(token).balanceOf(pair), pad.DEX_RESERVE() - pad.lockedAtGraduation(token), "the pool's share of the reserve sits in the pool");
        assertEq(IERC20(token).balanceOf(address(pad)), pad.lockedAtGraduation(token), "the virtual share stays locked in the pad");
        assertEq(weth.balanceOf(pair), 0.64 ether, "the raise sits in the pool");
        (uint256 vEth, uint256 vToken,,,,,) = pad.curves(token);
        assertEq(IERC20(token).balanceOf(pair), (0.64 ether * vToken) / vEth, "coins at the closing price");
        assertEq(IERC20(token).balanceOf(address(migrator)), 0, "nothing stranded in the adapter");
        assertEq(migrator.pairAsset(token), address(weth));
        assertEq(migrator.pairOf(token), pair);
        assertGt(migrator.liquidity(token), 0);
        assertEq(MockV2Pair(pair).balanceOf(address(migrator)), migrator.liquidity(token), "the adapter holds the LP tokens, and has no way to give them up");
        // the pool is the coin's from now on: taxed, and no cashback on what it holds
        assertTrue(pad.taxedPool(token, pair), "the pool migrate returned is registered");
        assertEq(address(pad.graduatedVia(token)), address(migrator));
        assertEq(
            pad.eligibleSupply(token),
            IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad)) - IERC20(token).balanceOf(pair)
                - IERC20(token).balanceOf(address(migrator)),
            "the eligible supply is what the holders own"
        );
        // nobody but the launchpad can use the adapter
        vm.expectRevert(UniV2Migrator.OnlyLaunchpad.selector);
        migrator.migrate(token, 1, address(0), 0);
    }

    function test_regularLaunchesAreUntouched() public {
        vm.prank(dave);
        address token = pad.createToken{value: 0.1 ether}("Fresh", "FRSH", 0, _meta(), address(0), false);
        assertEq(pad.migrationPending(token), 0);
        vm.prank(dave);
        pad.buy{value: 0.1 ether}(token, 0);
        assertGt(IERC20(token).balanceOf(dave), 0);
    }

    function test_aBatchSentTwiceRevertsInsteadOfPayingTwice() public {
        address[] memory first = new address[](1);
        uint256[] memory firstBal = new uint256[](1);
        first[0] = alice;
        firstBal[0] = bals[0];
        address token = mig.migrateToken{value: realQuote}(
            _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), first, firstBal
        );
        address[] memory second = new address[](1);
        uint256[] memory secondBal = new uint256[](1);
        second[0] = bob;
        secondBal[0] = bals[1];
        mig.migrateBalances(token, second, secondBal);
        // the same batch again (a script retrying after a timeout) must not deliver again
        vm.expectRevert(abi.encodeWithSelector(LaunchpadBase.AlreadyDelivered.selector, bob));
        mig.migrateBalances(token, second, secondBal);
        assertEq(IERC20(token).balanceOf(bob), bals[1], "delivered once");
        assertEq(pad.migrationPending(token), bals[2], "carol's share is still there for her");
        assertTrue(pad.migrationDelivered(token, bob));
        assertFalse(pad.migrationDelivered(token, carol));
    }

    // ------------------------------------------------------------ the quote

    /// The curve state implies the reserve; what arrives must match it to half a
    /// percent plus a millionth of a coin (the ledger rounds every trade by a unit).
    function test_aCurveCoinMustArriveWithItsReserve() public {
        uint256 expected = Math.mulDiv(virtualQuote, sold, pad.VIRTUAL_TOKEN() - sold);
        uint256 tolerance = expected / 200 + 1e12;
        LaunchpadBase.LedgerCoin memory c = _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold);
        // nothing, or twice as much, is refused
        c.quoteAmount = 0;
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken(c, holders, bals);
        c.quoteAmount = realQuote * 2;
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken{value: realQuote * 2}(c, holders, bals);
        // one unit past the tolerance, either way
        c.quoteAmount = expected + tolerance + 1;
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken{value: expected + tolerance + 1}(c, holders, bals);
        c.quoteAmount = expected - tolerance - 1;
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken{value: expected - tolerance - 1}(c, holders, bals);
        // rounding dust either way is fine, up to the tolerance itself
        c.quoteAmount = realQuote + 1e9;
        address token = mig.migrateToken{value: realQuote + 1e9}(c, holders, bals);
        (,, uint256 realEth,,,,) = pad.curves(token);
        assertEq(realEth, realQuote + 1e9);
        c.symbol = "LCAT2";
        c.quoteAmount = expected + tolerance;
        token = mig.migrateToken{value: expected + tolerance}(c, holders, bals);
        (,, realEth,,,,) = pad.curves(token);
        assertEq(realEth, expected + tolerance);
        c.symbol = "LCAT3";
        c.quoteAmount = expected - tolerance;
        token = mig.migrateToken{value: expected - tolerance}(c, holders, bals);
        (,, realEth,,,,) = pad.curves(token);
        assertEq(realEth, expected - tolerance);
    }

    /// A native quote arrives as msg.value, and exactly the figure the coin declares:
    /// the reserve check reads quoteAmount, so the two must be one.
    function test_aNativeCoinPaysExactlyWhatItDeclares() public {
        LaunchpadBase.LedgerCoin memory c = _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold);
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        mig.migrateToken(c, holders, bals); // nothing sent
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        mig.migrateToken{value: realQuote - 1}(c, holders, bals);
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        mig.migrateToken{value: realQuote + 1}(c, holders, bals);
        c.quoteAmount = realQuote * 2; // a wrong figure, paid in full: the reserve check is what refuses it
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken{value: realQuote * 2}(c, holders, bals);
        assertEq(address(pad).balance, 0, "nothing stuck in the pad");
        c.quoteAmount = realQuote;
        mig.migrateToken{value: realQuote}(c, holders, bals);
        assertEq(address(pad).balance, realQuote);
    }

    /// Base's pad is quoted in cbLTC (eight decimals): a coin arrives in it with the quote
    /// pulled from the caller, no value, and the reserve checked to the unit — half a
    /// percent plus one satoshi.
    function test_migrateTokenInAnErc20Quote() public {
        MockCbLTC cb = new MockCbLTC();
        uint256 vq = 20_000_000; // the ledger's 0.2 LTC, in cbLTC's eight decimals
        uint256 expected = Math.mulDiv(vq, sold, pad.VIRTUAL_TOKEN() - sold);
        LaunchpadBase.LedgerCoin memory c = _coin("Lite Cat", "LCAT", creator, false, vq, sold);
        c.quoteAsset = address(cb);
        c.quoteAmount = expected;
        cb.mint(address(this), 10 * expected);
        cb.approve(address(pad), type(uint256).max);

        // a quote this pad does not trade in is refused before anything is pulled
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        mig.migrateToken(c, holders, bals);
        pad.setQuoteAsset(address(cb), 30e8); // 30 cbLTC virtual, as on Base
        // no value with an ERC-20 quote
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        mig.migrateToken{value: 1}(c, holders, bals);
        // and the caller's approval must cover the whole figure
        cb.approve(address(pad), expected - 1);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(pad), expected - 1, expected)
        );
        mig.migrateToken(c, holders, bals);
        cb.approve(address(pad), type(uint256).max);

        address token = mig.migrateToken(c, holders, bals);
        assertEq(cb.balanceOf(address(pad)), expected, "the reserve was pulled from the caller");
        assertEq(cb.balanceOf(address(this)), 9 * expected);
        assertEq(address(pad).balance, 0);
        _assertCbCurve(token, cb, vq, expected);
        assertEq(IERC20(token).balanceOf(alice), bals[0]);
        _assertNotusFees(token, false);
        _tradeInCb(token, cb, expected);
    }

    function _assertCbCurve(address token, MockCbLTC cb, uint256 vq, uint256 expected) internal view {
        (uint256 vEth, uint256 vToken, uint256 realEth, uint256 soldNow,,, address quote) = pad.curves(token);
        assertEq(quote, address(cb), "the curve carries its quote asset");
        assertEq(vEth, vq + expected);
        assertEq(vToken, pad.VIRTUAL_TOKEN() - sold);
        assertEq(realEth, expected);
        assertEq(soldNow, sold);
    }

    /// Trading goes on in the ERC-20: the fee and the tax in cbLTC, the native entry closed.
    function _tradeInCb(address token, MockCbLTC cb, uint256 reserve) internal {
        uint256 amountIn = 1_000_000; // 0.01 cbLTC
        (uint256 fee, uint256 platform, uint256 tokensOut) = _quoteBuy(token, amountIn, PLATFORM + TAX);
        cb.mint(dave, amountIn);
        vm.startPrank(dave);
        cb.approve(address(pad), amountIn);
        pad.buyWithQuote(token, amountIn, tokensOut);
        vm.expectRevert(LaunchpadBase.WrongPayment.selector);
        pad.buy{value: amountIn}(token, 0);
        vm.stopPrank();
        assertEq(IERC20(token).balanceOf(dave), tokensOut);
        assertEq(fee, 15_000, "1.5% of 0.01 cbLTC");
        assertEq(cb.balanceOf(treasury), platform, "the launchpad's 0.5%, in cbLTC");
        assertEq(platform, 5_000);
        assertEq(pad.creatorFees(creator, address(cb)), fee - platform, "the coin's 1%, to the creator, in cbLTC");
        assertEq(cb.balanceOf(address(pad)), reserve + amountIn - platform, "the pad holds the reserve and the creator's claim");
        // a migrated holder sells for cbLTC
        (uint256 out, uint256 sellFee,) = _quoteSell(token, bals[2], PLATFORM + TAX);
        vm.startPrank(carol);
        IERC20(token).approve(address(pad), bals[2]);
        pad.sell(token, bals[2], out - sellFee);
        vm.stopPrank();
        assertEq(cb.balanceOf(carol), out - sellFee);
        assertEq(carol.balance, 0, "nothing native changes hands");
    }

    function test_anErc20ReserveIsCheckedToTheUnit() public {
        MockCbLTC cb = new MockCbLTC();
        pad.setQuoteAsset(address(cb), 30e8);
        uint256 vq = 20_000_000;
        uint256 expected = Math.mulDiv(vq, sold, pad.VIRTUAL_TOKEN() - sold);
        uint256 tolerance = expected / 200 + 1; // half a percent plus one satoshi
        assertGt(expected, 30_000_000, "a reserve in satoshi, not wei");
        cb.mint(address(this), 10 * expected);
        cb.approve(address(pad), type(uint256).max);
        LaunchpadBase.LedgerCoin memory c = _coin("Lite Cat", "LCAT", creator, false, vq, sold);
        c.quoteAsset = address(cb);
        // a tenth short: the ledger could not have paid its sells
        c.quoteAmount = expected - expected / 10;
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken(c, holders, bals);
        // one satoshi past the tolerance, either way
        c.quoteAmount = expected + tolerance + 1;
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken(c, holders, bals);
        c.quoteAmount = expected - tolerance - 1;
        vm.expectRevert(LaunchpadBase.WrongQuote.selector);
        mig.migrateToken(c, holders, bals);
        assertEq(cb.balanceOf(address(pad)), 0, "a refused coin pulls nothing");
        // one satoshi off: the ledger's own rounding
        c.quoteAmount = expected + 1;
        address token = mig.migrateToken(c, holders, bals);
        (,, uint256 realEth,,,,) = pad.curves(token);
        assertEq(realEth, expected + 1);
        c.symbol = "LCAT2";
        c.quoteAmount = expected - 1;
        token = mig.migrateToken(c, holders, bals);
        (,, realEth,,,,) = pad.curves(token);
        assertEq(realEth, expected - 1);
        // and the tolerance's own edges
        c.symbol = "LCAT3";
        c.quoteAmount = expected + tolerance;
        token = mig.migrateToken(c, holders, bals);
        (,, realEth,,,,) = pad.curves(token);
        assertEq(realEth, expected + tolerance);
        c.symbol = "LCAT4";
        c.quoteAmount = expected - tolerance;
        token = mig.migrateToken(c, holders, bals);
        (,, realEth,,,,) = pad.curves(token);
        assertEq(realEth, expected - tolerance);
        assertEq(cb.balanceOf(address(pad)), 4 * expected, "every reserve delivered sits in the pad");
    }

    /// A pooled coin arrives in an ERC-20 as well: its pool's quote side pulled from
    /// the caller and handed on to the DEX in that asset.
    function test_aPooledCoinArrivesInAnErc20Quote() public {
        MockCbLTC cb = new MockCbLTC();
        pad.setQuoteAsset(address(cb), 30e8);
        (UniV2Migrator migrator,, MockV2Factory factory) = _uniV2();
        uint256 poolToken = 150_000_000e18;
        uint256 poolQuote = 120_000_000; // 1.2 cbLTC
        uint256 owned = pad.TOTAL_SUPPLY() - poolToken;
        uint256[] memory full = new uint256[](3);
        full[0] = 500_000_000e18;
        full[1] = 300_000_000e18;
        full[2] = owned - full[0] - full[1];
        LaunchpadBase.LedgerCoin memory c = _coin("Pooled", "POOL", creator, true, 20_000_000, owned);
        c.poolToken = poolToken;
        c.quoteAsset = address(cb);
        c.quoteAmount = poolQuote;
        cb.mint(address(this), poolQuote);
        cb.approve(address(pad), poolQuote);
        address token = mig.migrateToken(c, holders, full);
        address pair = factory.getPair(token, address(cb));
        assertTrue(pair != address(0), "a token/cbLTC pair");
        assertEq(cb.balanceOf(pair), poolQuote, "the pool's quote side, in cbLTC");
        assertEq(IERC20(token).balanceOf(pair), poolToken, "against the pool's token side");
        assertEq(cb.balanceOf(address(pad)), 0, "nothing stays in the pad");
        assertEq(migrator.pairAsset(token), address(cb));
        assertTrue(pad.taxedPool(token, pair));
        (,,,,,, address quote) = pad.curves(token);
        assertEq(quote, address(cb));
    }

    // ------------------------------------------------------------ the fees

    /// The ledger's platformBps is noise: the coin takes this launchpad's fee as it stands
    /// the day it arrives, and keeps it.
    function test_theLaunchpadsFeeIsStampedNotTheLedgers() public {
        LaunchpadBase.LedgerCoin memory c = _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold);
        c.fees.platformBps = 123;
        address token = mig.migrateToken{value: realQuote}(c, holders, bals);
        (,,,,,, uint16 platformBps) = pad.feeConfig(token);
        assertEq(platformBps, 50, "the fee as deployed");
        assertEq(platformBps, pad.feeBps());

        pad.setFeeBps(100);
        c.symbol = "LCAT2";
        address later = mig.migrateToken{value: realQuote}(c, holders, bals);
        (,,,,,, uint16 laterBps) = pad.feeConfig(later);
        assertEq(laterBps, 100, "the fee as it stands at the time");
        (,,,,,, platformBps) = pad.feeConfig(token);
        assertEq(platformBps, 50, "a live coin keeps the rate it arrived with");

        // and that is what every trade pays: 1% on the first coin's buys, 2% on the second's
        uint256 ethIn = 0.01 ether;
        vm.prank(dave);
        pad.buy{value: ethIn}(token, 0);
        assertEq(treasury.balance, (ethIn * 50) / 10_000);
        vm.prank(dave);
        pad.buy{value: ethIn}(later, 0);
        assertEq(treasury.balance, (ethIn * 50) / 10_000 + (ethIn * 100) / 10_000);
        assertEq(pad.creatorFees(creator, address(0)), 2 * (ethIn * TAX) / 10_000, "the coin's tax is the ledger's either way");
    }

    /// A ledger coin whose creator had redirected the creator share keeps the redirection;
    /// one without it pays the creator.
    function test_theLedgersFeeRecipientIsHonoured() public {
        address vault = makeAddr("vault");
        LaunchpadBase.LedgerCoin memory c = _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold);
        c.feeRecipient = vault;
        address token = mig.migrateToken{value: realQuote}(c, holders, bals);
        assertEq(pad.feeRecipient(token), vault);
        (,,,,, address creatorNow,) = pad.curves(token);
        assertEq(creatorNow, creator, "the creator is still the creator");
        uint256 ethIn = 0.01 ether;
        vm.prank(dave);
        pad.buy{value: ethIn}(token, 0);
        assertEq(pad.creatorFees(vault, address(0)), (ethIn * TAX) / 10_000, "the creator share accrues to the vault");
        assertEq(pad.creatorFees(creator, address(0)), 0);
        vm.prank(vault);
        pad.claimCreatorFees(address(0));
        assertEq(vault.balance, (ethIn * TAX) / 10_000);
        // the creator may still move it, as the creator of any coin
        vm.prank(creator);
        pad.setFeeRecipient(token, address(0));
        assertEq(pad.feeRecipient(token), address(0));

        c.symbol = "LCAT2";
        c.feeRecipient = address(0);
        address plain = mig.migrateToken{value: realQuote}(c, holders, bals);
        assertEq(pad.feeRecipient(plain), address(0), "no override: the creator");
        vm.prank(dave);
        pad.buy{value: ethIn}(plain, 0);
        assertEq(pad.creatorFees(creator, address(0)), (ethIn * TAX) / 10_000);
    }

    function test_theLedgersMetadataArrivesWhole() public {
        LaunchpadBase.LedgerCoin memory c = _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold);
        c.meta = LaunchpadBase.TokenMetadata({
            logoURI: "ipfs://QmLogo",
            website: "https://litecat.example",
            twitter: "https://x.com/litecat",
            telegram: "https://t.me/litecat",
            livestream: "https://live.example/litecat",
            description: "A cat on Litecoin, now here"
        });
        address token = mig.migrateToken{value: realQuote}(c, holders, bals);
        (
            string memory logo,
            string memory website,
            string memory twitter,
            string memory telegram,
            string memory livestream,
            string memory description
        ) = pad.tokenMetadata(token);
        assertEq(logo, "ipfs://QmLogo");
        assertEq(website, "https://litecat.example");
        assertEq(twitter, "https://x.com/litecat");
        assertEq(telegram, "https://t.me/litecat");
        assertEq(livestream, "https://live.example/litecat");
        assertEq(description, "A cat on Litecoin, now here");
        assertEq(LaunchToken(token).name(), "Lite Cat");
        assertEq(LaunchToken(token).symbol(), "LCAT");
    }

    // ------------------------------------------------------------ the operator

    /// The owner — a timelock — names an operator for the days of a move: the operator
    /// opens the migration and runs it in, and holds none of the owner's other powers.
    function test_theOperatorRunsTheMigrationInAndNothingElse() public {
        Launchpad fresh = new Launchpad(treasury);
        ILaunchpadMigration fm = ILaunchpadMigration(address(fresh));
        address op = makeAddr("operator");
        vm.deal(op, 10 ether);

        // the owner names the operator, in the open
        vm.prank(dave);
        vm.expectRevert(_ownableError(dave));
        fm.setMigrationOperator(op);
        vm.expectEmit(address(fresh));
        emit LaunchpadBase.MigrationOperatorUpdated(op);
        fm.setMigrationOperator(op);
        assertEq(fresh.migrationOperator(), op);

        // the operator opens the migration and brings the coins in
        address[] memory first = new address[](1);
        uint256[] memory firstBal = new uint256[](1);
        first[0] = alice;
        firstBal[0] = bals[0];
        address[] memory rest = new address[](2);
        uint256[] memory restBal = new uint256[](2);
        rest[0] = bob;
        rest[1] = carol;
        restBal[0] = bals[1];
        restBal[1] = bals[2];
        vm.startPrank(op);
        fm.setMigrationRoot(ROOT, 3_600_085);
        assertEq(fresh.migrationRoot(), ROOT);
        address token = fm.migrateToken{value: realQuote}(
            _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), first, firstBal
        );
        assertEq(IERC20(token).balanceOf(alice), bals[0]);
        fm.migrateBalances(token, rest, restBal);
        assertEq(fresh.migrationPending(token), 0);
        assertEq(address(fresh).balance, realQuote, "the operator paid the reserve");

        // but none of the owner's powers
        vm.expectRevert(_ownableError(op));
        fm.announceFreeze(block.number + 5);
        vm.expectRevert(_ownableError(op));
        fm.cancelFreeze();
        vm.expectRevert(_ownableError(op));
        fm.closeMigration();
        vm.expectRevert(_ownableError(op));
        fm.migrateOut(token, op);
        vm.expectRevert(_ownableError(op));
        fm.setMigrationOperator(dave);
        vm.expectRevert(_ownableError(op));
        fresh.setFeeBps(100);
        vm.stopPrank();
        assertEq(fresh.migrationOperator(), op, "still the operator");
        assertEq(fresh.freezeBlock(), 0);
    }

    function test_aStrangerHasNoMigrationPower() public {
        address op = makeAddr("operator");
        mig.setMigrationOperator(op);
        address token = _migrate(false);
        address[] memory none = new address[](0);
        uint256[] memory noneBal = new uint256[](0);
        vm.startPrank(dave);
        vm.expectRevert(LaunchpadBase.NotOperator.selector);
        mig.setMigrationRoot(ROOT, 1);
        vm.expectRevert(LaunchpadBase.NotOperator.selector);
        mig.migrateToken{value: realQuote}(_coin("Dog", "DOG", creator, false, virtualQuote, sold), holders, bals);
        vm.expectRevert(LaunchpadBase.NotOperator.selector);
        mig.migrateBalances(token, none, noneBal);
        vm.expectRevert(_ownableError(dave));
        mig.announceFreeze(block.number + 5);
        vm.expectRevert(_ownableError(dave));
        mig.cancelFreeze();
        vm.expectRevert(_ownableError(dave));
        mig.closeMigration();
        vm.expectRevert(_ownableError(dave));
        mig.migrateOut(token, dave);
        vm.expectRevert(_ownableError(dave));
        mig.setMigrationOperator(dave);
        vm.stopPrank();
        assertEq(pad.migrationOperator(), op);
        assertEq(pad.tokenCount(), 1, "nothing of the stranger's landed");
    }

    function test_closingTheMigrationEndsTheOperatorsRole() public {
        address op = makeAddr("operator");
        vm.deal(op, 10 ether);
        mig.setMigrationOperator(op);
        address[] memory first = new address[](1);
        uint256[] memory firstBal = new uint256[](1);
        first[0] = alice;
        firstBal[0] = bals[0];
        vm.prank(op);
        address token = mig.migrateToken{value: realQuote}(
            _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), first, firstBal
        );
        assertEq(pad.migrationPending(token), bals[1] + bals[2]);

        vm.expectEmit(address(pad));
        emit LaunchpadBase.MigrationClosed();
        vm.expectEmit(address(pad));
        emit LaunchpadBase.MigrationOperatorUpdated(address(0));
        mig.closeMigration();
        assertTrue(pad.migrationClosed());
        assertEq(pad.migrationOperator(), address(0), "the role ended with the migration");

        // the former operator is a stranger now, even for what is still pending
        address[] memory rest = new address[](2);
        uint256[] memory restBal = new uint256[](2);
        rest[0] = bob;
        rest[1] = carol;
        restBal[0] = bals[1];
        restBal[1] = bals[2];
        vm.prank(op);
        vm.expectRevert(LaunchpadBase.NotOperator.selector);
        mig.migrateBalances(token, rest, restBal);
        // the owner delivers what is left; no coin arrives any more, from anyone
        mig.migrateBalances(token, rest, restBal);
        assertEq(pad.migrationPending(token), 0);
        assertEq(IERC20(token).balanceOf(carol), bals[2]);
        vm.expectRevert(LaunchpadBase.MigrationNotOpen.selector);
        mig.migrateToken{value: realQuote}(_coin("Dog", "DOG", creator, false, virtualQuote, sold), holders, bals);
        // naming an operator again changes nothing: the migration is closed for good
        mig.setMigrationOperator(op);
        vm.prank(op);
        vm.expectRevert(LaunchpadBase.MigrationNotOpen.selector);
        mig.migrateToken{value: realQuote}(_coin("Dog", "DOG", creator, false, virtualQuote, sold), holders, bals);
    }

    function test_aTickerMigratesOnce() public {
        _migrate(false);
        vm.expectRevert(LaunchpadBase.TickerMigrated.selector);
        _migrate(false);
        assertTrue(pad.migratedTicker(keccak256("LCAT")) != address(0));
    }

    function test_migrationNeedsARootAndEndsWhenClosed() public {
        Launchpad fresh = new Launchpad(treasury);
        ILaunchpadMigration freshMig = ILaunchpadMigration(address(fresh));
        vm.expectRevert(LaunchpadBase.MigrationNotOpen.selector);
        freshMig.migrateToken{value: realQuote}(_coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), holders, bals);
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        freshMig.setMigrationRoot(bytes32(0), 1);
        freshMig.setMigrationRoot(ROOT, 3_600_085);
        assertEq(fresh.migrationRoot(), ROOT);
        assertEq(fresh.migrationFreezeHeight(), 3_600_085);
        vm.expectRevert(LaunchpadBase.BadMigration.selector);
        freshMig.setMigrationRoot(bytes32(uint256(2)), 1); // never changed
        vm.deal(address(this), 200 ether);
        address token = freshMig.migrateToken{value: realQuote}(_coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), holders, bals);
        freshMig.closeMigration();
        vm.expectRevert(LaunchpadBase.MigrationNotOpen.selector);
        freshMig.migrateToken{value: realQuote}(_coin("Dog", "DOG", creator, false, virtualQuote, sold), holders, bals);
        // what was already migrated keeps trading
        vm.prank(dave);
        fresh.buy{value: 0.01 ether}(token, 0);
        assertGt(IERC20(token).balanceOf(dave), 0);
    }

    // ------------------------------------------------------------ the way out

    /// A graduated coin's pool trades leave coins with the pad (taxTreasury, taxPot) for
    /// the harvest to sell; whatever is still unsold when the coin leaves is burned with
    /// the pool's token side, so the supply left is exactly what holders own.
    function test_migrateOutBurnsTheUnsoldTaxBuckets() public {
        (UniV2Migrator migrator, MockWETH9 weth,) = _uniV2();
        // a coin of this pad's own, taxed 1% a side (the pot to its creator), graduated by one big buy
        vm.prank(creator);
        address token = pad.createTokenWithFees("Taxed", "TAXD", 0, _meta(), address(0), _fees(false));
        vm.prank(dave);
        pad.buy{value: 6 ether}(token, 0); // the curve raises ~4 ETH: it graduates into a token/WETH pool
        (,,,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        address pair = migrator.pairOf(token);
        assertTrue(pad.taxedPool(token, pair), "the pool is registered: trades on it are taxed");
        assertEq(pad.transferRate(token, dave, pair), PLATFORM + TAX);

        // a sell and a buy on the pool: both buckets fill with coins nobody harvested
        _poolSell(dave, token, pair, 10_000_000e18);
        _poolBuy(dave, token, pair, weth, 0.05 ether);
        Before memory b = _snapshot(token, pair);
        assertGt(b.tT, 0, "the launchpad's bucket");
        assertGt(b.tP, 0, "the coin's bucket");
        assertApproxEqAbs(b.tP, (b.tT * TAX) / PLATFORM, 4, "split at the rate the token applied, 0.5% to 1%: two trades, two units of rounding each");
        assertEq(IERC20(token).balanceOf(address(pad)), b.locked + b.tT + b.tP, "the pad holds the locked share and the buckets");
        assertEq(pad.burned(token), 0, "nothing burned yet");

        mig.announceFreeze(block.number + 5);
        vm.roll(block.number + 5);
        assertTrue(pad.frozen());
        (uint256 quoteOut, uint256 tokensBurned) = mig.migrateOut(token, cold);

        assertEq(pad.taxTreasury(token), 0, "the launchpad's bucket is gone");
        assertEq(pad.taxPot(token), 0, "the coin's bucket is gone");
        assertEq(pad.burned(token), b.tT + b.tP, "burned grew by the buckets: coins that left the curve and exist no more");
        assertEq(IERC20(token).totalSupply(), b.supply - tokensBurned, "the supply fell by everything burned");
        assertGt(tokensBurned, b.tT + b.tP, "the pool's token side came back and was burned too");
        assertLe(tokensBurned, b.tT + b.tP + b.pairTokens);
        assertGe(tokensBurned, b.tT + b.tP + (b.pairTokens * 999) / 1000, "all of the pool's side but Uniswap's minimum liquidity");
        assertEq(IERC20(token).balanceOf(address(pad)), b.locked, "nothing of the coin stays here but the share locked at graduation");
        assertEq(IERC20(token).balanceOf(dave), b.daveTokens, "holders keep theirs");
        assertEq(IERC20(token).totalSupply(), b.daveTokens + b.locked + IERC20(token).balanceOf(pair), "what is left: holders, the lock, the pool's dust");
        assertEq(weth.balanceOf(cold), quoteOut, "the pool's quote side, as WETH, to the bridge");
        assertGt(quoteOut, 0);
        assertTrue(pad.migratedOut(token));
        assertEq(pad.migratedPair(token), pair);
        assertEq(pad.transferRate(token, pair, dave), 0, "the pool it left pays out untaxed: nothing is booked after a coin left");
        vm.expectRevert(LaunchpadBase.Frozen.selector);
        pad.transferRate(token, dave, pair); // and nothing goes the other way
    }

    /// A graduated coin's state before it leaves.
    struct Before {
        uint256 tT; //         taxTreasury
        uint256 tP; //         taxPot
        uint256 locked; //     lockedAtGraduation
        uint256 supply;
        uint256 pairTokens;
        uint256 daveTokens;
    }

    function _snapshot(address token, address pair) internal view returns (Before memory b) {
        b.tT = pad.taxTreasury(token);
        b.tP = pad.taxPot(token);
        b.locked = pad.lockedAtGraduation(token);
        b.supply = IERC20(token).totalSupply();
        b.pairTokens = IERC20(token).balanceOf(pair);
        b.daveTokens = IERC20(token).balanceOf(dave);
    }

    // ------------------------------------------------------------ the module

    /// The fallback forwards the module's selectors and nothing else: an unknown call
    /// reverts in the module, and value comes in only through migrateToken.
    function test_theFallbackServesTheModulesSelectorsAlone() public {
        (bool ok, bytes memory ret) = address(pad).call(abi.encodeWithSignature("notAFunction(uint256)", 1));
        assertFalse(ok, "an unknown selector reverts, never a silent success");
        assertEq(ret.length, 0, "with nothing to say");
        (ok,) = address(pad).call{value: 1 ether}("");
        assertFalse(ok, "a bare transfer reverts");
        (ok,) = address(pad).call{value: 1 ether}(abi.encodeWithSignature("notAFunction(uint256)", 1));
        assertFalse(ok, "value with an unknown selector too");
        assertEq(address(pad).balance, 0, "nothing stuck in the pad");
        // the module's selectors are served at the pad's address, in the pad's storage
        (ok, ret) = address(pad).call(abi.encodeCall(ILaunchpadMigration.setMigrationOperator, (dave)));
        assertTrue(ok);
        assertEq(pad.migrationOperator(), dave);
        // and the module itself never holds anything of its own: its storage is not the pad's
        address module = pad.MIGRATION_MODULE();
        assertTrue(module != address(0) && module != address(pad));
        assertEq(Launchpad(payable(module)).migrationOperator(), address(0));
        assertEq(Launchpad(payable(module)).migrationRoot(), bytes32(0));
    }

    /// EIP-170: a contract over 24,576 bytes cannot be deployed at all (LitVM refused
    /// a Launchpad at 24,802). The pad keeps a margin for the next change; the module
    /// and the migrator must fit too, or nothing deploys.
    function test_launchpadFitsUnderTheContractSizeLimit() public {
        assertLe(address(pad).code.length, LIMIT - 150, "Launchpad runtime bytecode too close to the EIP-170 limit");
        address module = pad.MIGRATION_MODULE();
        assertGt(module.code.length, 0, "the module is deployed");
        assertLe(module.code.length, LIMIT, "LaunchpadMigration over the EIP-170 limit");
        (UniV2Migrator migrator,,) = _uniV2();
        assertGt(address(migrator).code.length, 0);
        assertLe(address(migrator).code.length, LIMIT, "UniV2Migrator over the EIP-170 limit");
    }
}
