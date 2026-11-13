// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";

/// cbLTC with a list of addresses it will not pay, as an issuer's token has.
contract RefusingQuote is MockCbLTC {
    mapping(address => bool) public refused;

    function refuse(address who, bool yes) external {
        refused[who] = yes;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!refused[to], "refused");
        super._update(from, to, value);
    }
}

/// A holder that is a contract: it buys on the curve and claims for itself.
contract ContractHolder {
    function buy(Launchpad pad, address token) external payable {
        pad.buy{value: msg.value}(token, 0);
    }

    function claim(Launchpad pad, address token) external {
        pad.claimCashback(token);
    }

    receive() external payable {}
}

/// What wallets delegate to (EIP-7702): one that takes the chain's coin, one
/// that refuses it, one that burns whatever gas it is given.
contract AcceptingDelegate {
    receive() external payable {}
}

contract RevertingDelegate {
    receive() external payable {
        revert("no");
    }
}

contract BurningDelegate {
    receive() external payable {
        while (true) {}
    }
}

/// claimCashbackFor: the cashback of wallets that have not come for it, sent
/// to them by anyone. It pays what claimCashback would have paid, to the
/// holder alone, once, delegated wallets included; it passes over contracts,
/// accounts that earn none and holders that cannot be paid, and each of those
/// keeps its claim.
contract CashbackPushTest is Test {
    event CashbackClaimed(address indexed token, address indexed holder, uint256 amount);

    Launchpad pad;
    ILaunchpadMigration mig;
    RefusingQuote quote;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates the coins
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address keeper = makeAddr("keeper"); // sends the push: holds no coin
    LaunchpadBase.TokenMetadata meta = LaunchpadBase.TokenMetadata("", "", "", "", "", "");
    /// 1% a side, the whole tax to holders as cashback.
    LaunchpadBase.FeeConfig holdersOnly = LaunchpadBase.FeeConfig(100, 100, 0, 10_000, 0, 0, 0);

    function setUp() public {
        pad = new Launchpad(treasury);
        mig = ILaunchpadMigration(address(pad));
        quote = new RefusingQuote();
        pad.setQuoteAsset(address(quote), 30e8); // as on Base
    }

    // ---------------------------------------------------------------- helpers

    function _buy(address who, address token, uint256 amount) internal {
        quote.mint(who, amount);
        vm.startPrank(who);
        quote.approve(address(pad), amount);
        pad.buyWithQuote(token, amount, 0);
        vm.stopPrank();
    }

    function _sell(address who, address token, uint256 amount) internal {
        vm.startPrank(who);
        IERC20(token).approve(address(pad), amount);
        pad.sell(token, amount, 0);
        vm.stopPrank();
    }

    /// A cbLTC coin with bob, carol and dave on its curve, each owed cashback
    /// by the buys that came after theirs (and by their own).
    function _cbltcCoin() internal returns (address token) {
        vm.prank(alice);
        token = pad.createTokenWithFees("Pushed", "PUSH", 0, meta, address(quote), holdersOnly);
        _buy(bob, token, 2e8);
        _buy(carol, token, 3e8);
        _buy(dave, token, 1e8);
        _buy(bob, token, 1e8);
    }

    /// The same on a curve quoted in the chain's coin, as on LitVM.
    function _nativeCoin() internal returns (address token) {
        vm.prank(alice);
        token = pad.createTokenWithFees("Native", "NAT", 0, meta, address(0), holdersOnly);
        address[3] memory who = [bob, carol, dave];
        for (uint256 i = 0; i < 3; i++) {
            vm.deal(who[i], 1 ether);
            vm.prank(who[i]);
            pad.buy{value: 0.5 ether}(token, 0);
        }
    }

    /// `who` as a wallet that delegated to `to`: its code is the EIP-7702
    /// designator, 0xef0100 and the delegate's address.
    function _delegate(address who, address to) internal {
        vm.etch(who, abi.encodePacked(hex"ef0100", to));
    }

    function _list(address a, address b, address c) internal pure returns (address[] memory out) {
        out = new address[](3);
        (out[0], out[1], out[2]) = (a, b, c);
    }

    // ------------------------------------------------------------------ pays

    function test_paysEachHolderWhatTheyCouldClaim() public {
        address token = _cbltcCoin();
        uint256 owedBob = pad.cashbackOf(token, bob);
        uint256 owedCarol = pad.cashbackOf(token, carol);
        uint256 owedDave = pad.cashbackOf(token, dave);
        assertGt(owedBob, 0);
        assertGt(owedCarol, 0);
        assertGt(owedDave, 0);
        uint256 padBefore = quote.balanceOf(address(pad));

        vm.expectEmit(true, true, false, true, address(pad));
        emit CashbackClaimed(token, bob, owedBob);
        vm.expectEmit(true, true, false, true, address(pad));
        emit CashbackClaimed(token, carol, owedCarol);
        vm.expectEmit(true, true, false, true, address(pad));
        emit CashbackClaimed(token, dave, owedDave);
        vm.prank(keeper);
        uint256 paid = mig.claimCashbackFor(token, _list(bob, carol, dave));

        assertEq(paid, owedBob + owedCarol + owedDave, "the sum of what each could claim");
        assertEq(quote.balanceOf(bob), owedBob, "bob's, to bob");
        assertEq(quote.balanceOf(carol), owedCarol, "carol's, to carol");
        assertEq(quote.balanceOf(dave), owedDave, "dave's, to dave");
        assertEq(quote.balanceOf(keeper), 0, "nothing to the one who sent it");
        assertEq(padBefore - quote.balanceOf(address(pad)), paid, "the pad paid that and no more");
        assertEq(pad.cashbackOf(token, bob) + pad.cashbackOf(token, carol) + pad.cashbackOf(token, dave), 0);

        // paid once: a second push finds nothing, and a claim has nothing to take
        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(token, _list(bob, carol, dave)), 0, "nothing twice");
        vm.prank(bob);
        vm.expectRevert(LaunchpadBase.ZeroAmount.selector);
        pad.claimCashback(token);
    }

    function test_paysWhatAClaimWouldHavePaid() public {
        address token = _cbltcCoin();
        uint256 snap = vm.snapshotState();
        vm.prank(carol);
        pad.claimCashback(token);
        uint256 byClaim = quote.balanceOf(carol);
        vm.revertToState(snap);

        address[] memory one = new address[](1);
        one[0] = carol;
        vm.prank(keeper);
        mig.claimCashbackFor(token, one);
        assertEq(quote.balanceOf(carol), byClaim, "the push and the claim pay the same");
    }

    /// A wallet that delegated (EIP-7702) is a wallet: its address has code,
    /// the 23 bytes of the delegation, and it is paid like any other. A third
    /// of the wallets holding a coin on Base were delegated in November 2026.
    function test_paysAWalletThatDelegated() public {
        address token = _cbltcCoin();
        uint256 owed = pad.cashbackOf(token, carol);
        _delegate(carol, address(new AcceptingDelegate()));
        assertEq(carol.code.length, 23);

        vm.prank(keeper);
        mig.claimCashbackFor(token, _list(bob, carol, dave));
        assertEq(quote.balanceOf(carol), owed, "paid");
        assertEq(pad.cashbackOf(token, carol), 0);
    }

    function test_paysADelegatedWalletInTheChainsCoin() public {
        address token = _nativeCoin();
        uint256 owed = pad.cashbackOf(token, carol);
        _delegate(carol, address(new AcceptingDelegate()));
        uint256 before = carol.balance;

        address[] memory one = new address[](1);
        one[0] = carol;
        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(token, one), owed);
        assertEq(carol.balance - before, owed, "its delegate's receive ran and took it");
    }

    function test_paysInTheChainsCoin() public {
        address token = _nativeCoin();
        uint256 owedBob = pad.cashbackOf(token, bob);
        uint256 owedCarol = pad.cashbackOf(token, carol);
        uint256 owedDave = pad.cashbackOf(token, dave);
        uint256 bobBefore = bob.balance;
        uint256 carolBefore = carol.balance;
        uint256 daveBefore = dave.balance;

        vm.prank(keeper);
        uint256 paid = mig.claimCashbackFor(token, _list(bob, carol, dave));

        assertGt(paid, 0);
        assertEq(paid, owedBob + owedCarol + owedDave);
        assertEq(bob.balance - bobBefore, owedBob);
        assertEq(carol.balance - carolBefore, owedCarol);
        assertEq(dave.balance - daveBefore, owedDave);
        assertEq(keeper.balance, 0, "nothing to the one who sent it");
    }

    /// A holder who sold everything keeps what accrued while they held, and
    /// the push finds it: the list is everyone who ever held, not who holds.
    function test_paysAHolderWhoSoldEverything() public {
        address token = _cbltcCoin();
        uint256 held = IERC20(token).balanceOf(dave);
        _sell(dave, token, held);
        assertEq(IERC20(token).balanceOf(dave), 0);
        uint256 owed = pad.cashbackOf(token, dave);
        assertGt(owed, 0, "accrued while he held");
        uint256 before = quote.balanceOf(dave);

        address[] memory one = new address[](1);
        one[0] = dave;
        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(token, one), owed);
        assertEq(quote.balanceOf(dave) - before, owed);
    }

    /// Cashback stays claimable on a frozen pad, and so pushable: the way to
    /// empty a pad of its holders' quote once its coins have moved on.
    function test_paysOnAFrozenPad() public {
        address token = _cbltcCoin();
        uint256 owed = pad.cashbackOf(token, bob);
        mig.announceFreeze(block.number + 5);
        vm.roll(block.number + 5);
        assertTrue(pad.frozen());

        address[] memory one = new address[](1);
        one[0] = bob;
        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(token, one), owed);
        assertEq(quote.balanceOf(bob), owed);
    }

    // ----------------------------------------------------------- passes over

    function test_passesOverAContractWhichClaimsForItself() public {
        vm.prank(alice);
        address token = pad.createTokenWithFees("Native", "NAT", 0, meta, address(0), holdersOnly);
        ContractHolder vault = new ContractHolder();
        vault.buy{value: 0.5 ether}(pad, token);
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        pad.buy{value: 0.5 ether}(token, 0);
        uint256 owedVault = pad.cashbackOf(token, address(vault));
        uint256 owedBob = pad.cashbackOf(token, bob);
        assertGt(owedVault, 0);
        uint256 vaultBefore = address(vault).balance;

        address[] memory both = new address[](2);
        (both[0], both[1]) = (address(vault), bob);
        vm.prank(keeper);
        uint256 paid = mig.claimCashbackFor(token, both);

        assertEq(paid, owedBob, "bob alone is paid");
        assertEq(address(vault).balance, vaultBefore, "nothing pushed into the contract");
        assertEq(pad.cashbackOf(token, address(vault)), owedVault, "its claim is whole");
        vault.claim(pad, token);
        assertEq(address(vault).balance - vaultBefore, owedVault, "and it claims for itself");
    }

    /// Twenty-three bytes that are not a delegation are a contract like any other.
    function test_passesOverCodeThatOnlyLooksLikeADelegation() public {
        address token = _cbltcCoin();
        uint256 owed = pad.cashbackOf(token, carol);
        vm.etch(carol, hex"6001600155600160025560016003556001600455600160");
        assertEq(carol.code.length, 23);

        vm.prank(keeper);
        mig.claimCashbackFor(token, _list(bob, carol, dave));
        assertEq(quote.balanceOf(carol), 0, "passed over");
        assertEq(pad.cashbackOf(token, carol), owed, "the claim is whole");
    }

    /// In a native quote the payment runs the code a wallet delegated to. One
    /// that reverts, and one that burns all the gas it is given, are passed
    /// over with their claims whole; the batch pays the others and spends on
    /// the burner no more than PUSH_GAS.
    function test_passesOverADelegateThatRevertsOrBurnsGas() public {
        address token = _nativeCoin();
        uint256 owedBob = pad.cashbackOf(token, bob);
        uint256 owedCarol = pad.cashbackOf(token, carol);
        uint256 owedDave = pad.cashbackOf(token, dave);
        _delegate(carol, address(new RevertingDelegate()));
        _delegate(dave, address(new BurningDelegate()));
        uint256 bobBefore = bob.balance;
        uint256 carolBefore = carol.balance;
        uint256 daveBefore = dave.balance;

        vm.prank(keeper);
        uint256 gasBefore = gasleft();
        uint256 paid = mig.claimCashbackFor(token, _list(carol, dave, bob));
        uint256 gasUsed = gasBefore - gasleft();

        assertEq(paid, owedBob, "bob is paid, after the two that could not be");
        assertEq(bob.balance - bobBefore, owedBob);
        assertEq(carol.balance, carolBefore);
        assertEq(dave.balance, daveBefore);
        assertEq(pad.cashbackOf(token, carol), owedCarol, "the claim of the one that reverts is whole");
        assertEq(pad.cashbackOf(token, dave), owedDave, "and of the one that burns gas");
        assertLt(gasUsed, 400_000, "the burner cost the batch its PUSH_GAS and no more");

        // each still claims for itself the day its delegation is gone
        vm.etch(carol, "");
        vm.prank(carol);
        pad.claimCashback(token);
        assertEq(carol.balance - carolBefore, owedCarol);
    }

    function test_passesOverAHolderTheQuoteRefusesAndPaysTheRest() public {
        address token = _cbltcCoin();
        uint256 owedBob = pad.cashbackOf(token, bob);
        uint256 owedCarol = pad.cashbackOf(token, carol);
        uint256 owedDave = pad.cashbackOf(token, dave);
        quote.refuse(carol, true);

        vm.prank(keeper);
        uint256 paid = mig.claimCashbackFor(token, _list(bob, carol, dave));
        assertEq(paid, owedBob + owedDave, "the others are paid");
        assertEq(quote.balanceOf(bob), owedBob);
        assertEq(quote.balanceOf(dave), owedDave);
        assertEq(quote.balanceOf(carol), 0);
        assertEq(pad.cashbackOf(token, carol), owedCarol, "her claim waits, whole");
        assertEq(pad.pendingCashback(token, carol), owedCarol, "booked, for the day the asset pays her");

        // more accrues on top of what was put back, and the day she can be paid she is paid all of it
        _buy(bob, token, 1e8);
        uint256 owedNow = pad.cashbackOf(token, carol);
        assertGt(owedNow, owedCarol);
        quote.refuse(carol, false);
        address[] memory one = new address[](1);
        one[0] = carol;
        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(token, one), owedNow);
        assertEq(quote.balanceOf(carol), owedNow);
    }

    function test_passesOverThePadTheZeroAddressAndTheEmptyHanded() public {
        address token = _cbltcCoin();
        uint256 owedBob = pad.cashbackOf(token, bob);
        address[] memory list = new address[](5);
        (list[0], list[1], list[2], list[3], list[4]) = (address(pad), address(0), keeper, bob, bob);

        uint256 padBefore = quote.balanceOf(address(pad));
        vm.prank(keeper);
        uint256 paid = mig.claimCashbackFor(token, list);
        assertEq(paid, owedBob, "bob once, though listed twice; the rest have nothing or earn none");
        assertEq(padBefore - quote.balanceOf(address(pad)), owedBob);
        assertEq(quote.balanceOf(address(0)), 0);

        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(token, new address[](0)), 0, "an empty list is no error");
    }

    /// One coin's push takes nothing of another coin's cashback.
    function test_paysOfTheNamedCoinAlone() public {
        address token = _cbltcCoin();
        vm.prank(alice);
        address other = pad.createTokenWithFees("Other", "OTH", 0, meta, address(quote), holdersOnly);
        _buy(bob, other, 2e8);
        _buy(carol, other, 2e8);
        uint256 owedOther = pad.cashbackOf(other, bob);
        uint256 owed = pad.cashbackOf(token, bob);
        assertGt(owedOther, 0);
        uint256 before = quote.balanceOf(bob);

        address[] memory one = new address[](1);
        one[0] = bob;
        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(token, one), owed);
        assertEq(quote.balanceOf(bob) - before, owed);
        assertEq(pad.cashbackOf(other, bob), owedOther, "the other coin's is untouched");
    }

    /// A coin the pad never created has no cashback: nothing is paid.
    function test_paysNothingOnAnAddressThePadNeverCreated() public {
        _cbltcCoin();
        uint256 padBefore = quote.balanceOf(address(pad));
        vm.prank(keeper);
        assertEq(mig.claimCashbackFor(address(quote), _list(bob, carol, dave)), 0);
        assertEq(quote.balanceOf(address(pad)), padBefore);
    }

    // ------------------------------------------------------------------ fuzz

    /// Any run of buys and sells, any list (holders, strangers, repeats): the
    /// push pays each wallet exactly what cashbackOf said, the pad pays out
    /// the sum and no more, and what the pad still holds covers the curve's
    /// reserve.
    function testFuzz_paysExactlyWhatWasOwed(uint256 seed) public {
        vm.prank(alice);
        address token = pad.createTokenWithFees("Fuzzed", "FUZZ", 0, meta, address(quote), holdersOnly);
        address[4] memory who = [bob, carol, dave, keeper];
        for (uint256 step = 0; step < 24; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            address a = who[seed % 3];
            uint256 bal = IERC20(token).balanceOf(a);
            if ((seed >> 8) % 3 == 0 && bal != 0) {
                _sell(a, token, ((seed >> 16) % bal) + 1);
            } else {
                _buy(a, token, ((seed >> 16) % 5e7) + 1e5);
            }
            (,,,, bool graduated,,) = pad.curves(token);
            if (graduated) break; // no migrator here: the test is of the curve
        }

        address[] memory list = new address[](6);
        uint256[4] memory owed;
        uint256[4] memory before;
        for (uint256 i = 0; i < 6; i++) {
            list[i] = who[(seed >> (i * 8)) % 4];
        }
        bool[4] memory listed;
        for (uint256 i = 0; i < 6; i++) {
            for (uint256 j = 0; j < 4; j++) {
                if (list[i] == who[j]) listed[j] = true;
            }
        }
        uint256 expected;
        for (uint256 j = 0; j < 4; j++) {
            owed[j] = pad.cashbackOf(token, who[j]);
            before[j] = quote.balanceOf(who[j]);
            if (listed[j]) expected += owed[j];
        }
        uint256 padBefore = quote.balanceOf(address(pad));

        vm.prank(makeAddr("anyone"));
        uint256 paid = mig.claimCashbackFor(token, list);

        assertEq(paid, expected, "the sum of the listed wallets' claims");
        assertEq(padBefore - quote.balanceOf(address(pad)), paid, "the pad paid that and no more");
        uint256 stillOwed;
        for (uint256 j = 0; j < 4; j++) {
            assertEq(
                quote.balanceOf(who[j]) - before[j], listed[j] ? owed[j] : 0, "each their own, the unlisted nothing"
            );
            assertEq(pad.cashbackOf(token, who[j]), listed[j] ? 0 : owed[j], "paid claims are gone, the others whole");
            stillOwed += pad.cashbackOf(token, who[j]);
        }
        (,, uint256 realQuote,,,,) = pad.curves(token);
        assertGe(quote.balanceOf(address(pad)), realQuote + stillOwed, "the reserve and the claims left are backed");
    }
}
