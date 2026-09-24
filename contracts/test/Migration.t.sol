// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV2Migrator, IUniswapV2Router02} from "../src/UniV2Migrator.sol";
import {IDexMigrator} from "../src/interfaces/IDexMigrator.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

contract RecordingMigrator is IDexMigrator {
    address public lastToken;
    uint256 public lastTokenAmount;
    uint256 public lastEthAmount;

    function migrate(address token, uint256 tokenAmount, address, uint256) external payable {
        lastToken = token;
        lastTokenAmount = tokenAmount;
        lastEthAmount = msg.value;
    }
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped zkLTC", "WzkLTC") {}
}

/// Just enough of a Uniswap v2 router to prove the adapter's plumbing: it
/// takes the tokens and the native coin and hands back "LP" units.
contract MockV2Router is IUniswapV2Router02 {
    MockWETH public immutable weth = new MockWETH();
    address public lastToken;
    uint256 public lastTokenAmount;
    uint256 public lastEthAmount;

    function factory() external view returns (address) {
        return address(this);
    }

    function WETH() external view returns (address) {
        return address(weth);
    }

    function getPair(address, address) external pure returns (address) {
        return address(0xBEEF);
    }

    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        pure
        returns (uint256, uint256, uint256)
    {
        revert("native only in this mock");
    }

    function addLiquidityETH(address token, uint256 amountTokenDesired, uint256, uint256, address, uint256)
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        lastToken = token;
        lastTokenAmount = amountTokenDesired;
        lastEthAmount = msg.value;
        return (amountTokenDesired, msg.value, amountTokenDesired / 1e9 + msg.value);
    }
}

/// Migrating a coin from the Litecoin ledger: the frozen state (8-decimal
/// litoshi and coin units scaled by 1e10) is re-created here and trading
/// continues at the same price, with the same holders.
contract MigrationTest is Test {
    uint256 constant SCALE = 1e10;

    Launchpad pad;
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");

    // a plausible frozen ledger: 0.2 LTC virtual, 0.31483 LTC in the curve, 642.1M sold
    uint256 virtualQuote = 20_000_000 * SCALE;
    uint256 realQuote = 31_483_000 * SCALE;
    uint256[] bals = [uint256(244_740_000e8 * SCALE), 215_430_000e8 * SCALE, 181_930_000e8 * SCALE];
    address[] holders = [alice, bob, carol];
    uint256 sold = bals[0] + bals[1] + bals[2];

    function setUp() public {
        pad = new Launchpad(treasury, address(0));
        vm.deal(address(this), 100 ether);
        vm.deal(dave, 100 ether);
    }

    function _meta() internal pure returns (Launchpad.TokenMetadata memory m) {
        m.logoURI = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
        m.description = "Migrated from Notus on Litecoin";
    }

    function _coin(
        string memory name,
        string memory symbol,
        address creator_,
        bool holdersMode,
        uint256 vq,
        uint256 sold_
    ) internal pure returns (Launchpad.LedgerCoin memory) {
        return Launchpad.LedgerCoin({
            name: name,
            symbol: symbol,
            meta: _meta(),
            creator: creator_,
            feesToHolders: holdersMode,
            virtualQuote: vq,
            sold: sold_
        });
    }

    function _migrate(bool holdersMode) internal returns (address) {
        return pad.migrateToken{value: realQuote}(
            _coin("Lite Cat", "LCAT", creator, holdersMode, virtualQuote, sold), holders, bals
        );
    }

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
        assertEq(pad.currentPrice(token), (vEth * 1e18) / vToken);
        (string memory logo,,,,, string memory description) = pad.tokenMetadata(token);
        assertEq(logo, "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
        assertEq(description, "Migrated from Notus on Litecoin");
        assertEq(pad.tokenCount(), 1);
    }

    function test_tradingContinuesAtTheLedgerPrice() public {
        address token = _migrate(false);
        // the same constant-product arithmetic the ledger used, on the migrated reserves
        uint256 ethIn = 0.01 ether;
        uint256 forCurve = ethIn - (ethIn * pad.feeBps()) / pad.FEE_DENOMINATOR();
        uint256 k = (virtualQuote + realQuote) * (pad.VIRTUAL_TOKEN() - sold);
        uint256 expected = (pad.VIRTUAL_TOKEN() - sold) - k / (virtualQuote + realQuote + forCurve);
        assertEq(pad.quoteBuy(token, ethIn), expected);

        vm.prank(dave);
        pad.buy{value: ethIn}(token, expected);
        assertEq(IERC20(token).balanceOf(dave), expected);
        assertEq(pad.creatorFees(creator, address(0)), (ethIn / 100) * 8_000 / 10_000, "creator mode: 80% of the fee");

        // a migrated holder sells into the migrated reserve
        uint256 half = bals[0] / 2;
        uint256 quotedOut = pad.quoteSell(token, half);
        vm.startPrank(alice);
        IERC20(token).approve(address(pad), half);
        pad.sell(token, half, quotedOut);
        vm.stopPrank();
        assertEq(alice.balance, quotedOut);
        (,, uint256 realEth,,,,) = pad.curves(token);
        assertEq(
            realEth, realQuote + forCurve - (quotedOut * 10_000) / 9_900 - 0, "reserve moved by the buy and the sell"
        );
        assertLe(realEth + quotedOut + (ethIn / 100), realQuote + ethIn, "never pays out more than it holds");
    }

    function test_tradingWaitsUntilEveryHolderIsServed() public {
        address[] memory first = new address[](1);
        uint256[] memory firstBal = new uint256[](1);
        first[0] = alice;
        firstBal[0] = bals[0];
        address token = pad.migrateToken{value: realQuote}(
            _coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), first, firstBal
        );
        assertEq(pad.migrationPending(token), bals[1] + bals[2]);

        vm.prank(dave);
        vm.expectRevert(Launchpad.MigrationPending.selector);
        pad.buy{value: 0.01 ether}(token, 0);
        vm.prank(alice);
        vm.expectRevert(Launchpad.MigrationPending.selector);
        pad.sell(token, 1e18, 0);

        address[] memory rest = new address[](2);
        uint256[] memory restBal = new uint256[](2);
        rest[0] = bob;
        rest[1] = carol;
        restBal[0] = bals[1];
        restBal[1] = bals[2] + 1; // one unit more than the ledger sold
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateBalances(token, rest, restBal);

        restBal[1] = bals[2];
        pad.migrateBalances(token, rest, restBal);
        assertEq(pad.migrationPending(token), 0);
        assertEq(IERC20(token).balanceOf(carol), bals[2]);

        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateBalances(token, rest, restBal); // nothing left to deliver

        vm.prank(dave);
        pad.buy{value: 0.01 ether}(token, 0);
        assertGt(IERC20(token).balanceOf(dave), 0);
    }

    function test_onlyTheOwnerMigrates() public {
        vm.prank(dave);
        vm.expectRevert();
        pad.migrateToken{value: realQuote}(_coin("Lite Cat", "LCAT", creator, false, virtualQuote, sold), holders, bals);
    }

    function test_rejectsStateTheLedgerCouldNotHaveProduced() public {
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateToken{value: realQuote}(_coin("X", "X", address(0), false, virtualQuote, sold), holders, bals);
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateToken{value: realQuote}(_coin("X", "X", creator, false, 0, sold), holders, bals);
        uint256 tooMuch = pad.CURVE_SUPPLY() + 1; // (an external call inside the arguments would eat the expectRevert)
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateToken{value: realQuote}(_coin("X", "X", creator, false, virtualQuote, tooMuch), holders, bals);
        uint256[] memory short = new uint256[](2);
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateToken{value: realQuote}(_coin("X", "X", creator, false, virtualQuote, sold), holders, short);
        // balances that exceed what the ledger sold
        uint256[] memory tooMany = new uint256[](3);
        tooMany[0] = sold;
        tooMany[1] = 1;
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateToken{value: realQuote}(_coin("X", "X", creator, false, virtualQuote, sold), holders, tooMany);
        // an untraded coin carries no reserve and no holders
        address[] memory none = new address[](0);
        uint256[] memory noneBal = new uint256[](0);
        vm.expectRevert(Launchpad.BadMigration.selector);
        pad.migrateToken{value: 1}(_coin("X", "X", creator, false, virtualQuote, 0), none, noneBal);
        address empty = pad.migrateToken(_coin("Empty", "EMPTY", creator, false, virtualQuote, 0), none, noneBal);
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
        address token = pad.migrateToken{value: raised}(
            _coin("Done", "DONE", creator, true, virtualQuote, pad.CURVE_SUPPLY()), holders, full
        );
        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertTrue(LaunchToken(token).graduated());
        assertEq(realEth, 0, "the reserve went to the DEX");
        assertEq(migrator.lastToken(), token);
        assertEq(migrator.lastTokenAmount(), pad.DEX_RESERVE());
        assertEq(migrator.lastEthAmount(), raised);
        // graduated: holders can now transfer freely
        vm.prank(alice);
        IERC20(token).transfer(dave, 1e18);
        assertEq(IERC20(token).balanceOf(dave), 1e18);
    }

    function test_holdersModeKeepsPayingMigratedHolders() public {
        address token = _migrate(true);
        vm.prank(dave);
        pad.buy{value: 0.05 ether}(token, 0); // small enough not to sell the curve out
        // holders mode: 20% of the fee went to the treasury, the other 80% is the pot
        uint256 pot = treasury.balance * 4;
        assertEq(pot, (0.0005 ether * 8_000) / 10_000);
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
        MockV2Router router = new MockV2Router();
        UniV2Migrator migrator = new UniV2Migrator(address(pad), address(router));
        pad.setMigrator(address(migrator));
        uint256[] memory full = new uint256[](3);
        full[0] = pad.CURVE_SUPPLY() / 2;
        full[1] = pad.CURVE_SUPPLY() / 4;
        full[2] = pad.CURVE_SUPPLY() - full[0] - full[1];
        address token = pad.migrateToken{value: 0.64 ether}(
            _coin("Done", "DONE", creator, false, virtualQuote, pad.CURVE_SUPPLY()), holders, full
        );
        assertEq(router.lastToken(), token);
        assertEq(router.lastTokenAmount(), pad.DEX_RESERVE());
        assertEq(router.lastEthAmount(), 0.64 ether);
        assertEq(IERC20(token).balanceOf(address(router)), pad.DEX_RESERVE(), "the reserve sits in the pool");
        assertEq(IERC20(token).balanceOf(address(migrator)), 0, "nothing stranded in the adapter");
        assertEq(migrator.pairAsset(token), router.WETH());
        assertGt(migrator.liquidity(token), 0);
        assertEq(migrator.pairOf(token), address(0xBEEF));
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
}
