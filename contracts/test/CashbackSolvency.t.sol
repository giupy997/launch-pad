// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";

/// Holder cashback must stay solvent and exact through any mix of activity on
/// a coin whose transfers are open while its curve trades (a pre-market):
/// wallet transfers, self-transfers, buys and sells on the curve, claims.
contract CashbackSolvencyTest is Test {
    Launchpad pad;
    address token;
    address treasury = makeAddr("treasury");
    address[4] holders;

    function setUp() public {
        pad = new Launchpad(treasury);
        for (uint256 i = 0; i < 4; i++) {
            holders[i] = makeAddr(string(abi.encodePacked("holder", i)));
            vm.deal(holders[i], 100 ether);
        }
        // a pre-market: transferable from day one, its whole pot to holders as cashback
        token = pad.createPreMarket("Solvent", "SOLV", Launchpad.TokenMetadata("", "", "", "", "", ""), 1e18);
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(holders[i]);
            pad.buy{value: 0.5 ether}(token, 0);
        }
    }

    function testFuzz_solventAndInSync(uint256 seed) public {
        for (uint256 step = 0; step < 40; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            address a = holders[seed % 4];
            address b = holders[(seed >> 8) % 4];
            uint256 op = (seed >> 16) % 5;
            uint256 bal = IERC20(token).balanceOf(a);
            uint256 amount = bal == 0 ? 0 : (seed >> 24) % (bal + 1);

            if (op == 0) {
                vm.prank(a);
                IERC20(token).transfer(b, amount); // may be a self-transfer when a == b
            } else if (op == 1) {
                vm.prank(a);
                IERC20(token).transfer(a, bal); // explicit self-transfer
            } else if (op == 2) {
                uint256 eth = ((seed >> 24) % 0.2 ether) + 1e15;
                vm.prank(a);
                pad.buy{value: eth}(token, 0); // a buy: its fee is everyone's cashback
            } else if (op == 3) {
                if (amount > 1e18) {
                    vm.startPrank(a);
                    IERC20(token).approve(address(pad), amount);
                    pad.sell(token, amount, 0); // a sell, likewise
                    vm.stopPrank();
                }
            } else if (pad.cashbackOf(token, a) > 0) {
                vm.prank(a);
                pad.claimCashback(token);
            }

            _checkInvariants();
        }
    }

    function _checkInvariants() internal view {
        uint256 outside = IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad));
        assertEq(pad.eligibleSupply(token), outside, "eligible supply in sync");

        (,, uint256 realEth,,,,) = pad.curves(token);
        uint256 owed = realEth + pad.creatorFees(treasury, address(0));
        for (uint256 i = 0; i < 4; i++) {
            owed += pad.cashbackOf(token, holders[i]);
        }
        owed += pad.cashbackOf(token, treasury);
        assertLe(owed, address(pad).balance, "every claim, and the curve's reserve, is backed");
    }

    function test_curveFeesReachTheHoldersWhole() public {
        uint256 held;
        for (uint256 i = 0; i < 4; i++) {
            held += IERC20(token).balanceOf(holders[i]);
        }
        assertEq(pad.eligibleSupply(token), held, "only wallets count");

        uint256 before = _claimable();
        uint256 treasuryBefore = treasury.balance;
        address dave = makeAddr("dave");
        vm.deal(dave, 1 ether);
        vm.prank(dave);
        pad.buy{value: 1 ether}(token, 0);
        // the 80% pot of the 1% fee is everyone's cashback, dave's own share included (his coins
        // are his before the fee is split), less wei-level rounding
        assertApproxEqAbs(_claimable() + pad.cashbackOf(token, dave) - before, 0.008 ether, 100);
        assertEq(treasury.balance - treasuryBefore, 0.002 ether, "the treasury share is paid straight out");
    }

    function _claimable() internal view returns (uint256 total) {
        for (uint256 i = 0; i < 4; i++) {
            total += pad.cashbackOf(token, holders[i]);
        }
    }
}
