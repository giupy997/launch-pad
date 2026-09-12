// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {IDexMigrator} from "../src/interfaces/IDexMigrator.sol";

/// Stands in for the v4 migration: parks the DEX reserve at the pool manager
/// address, like a real pool would hold it.
contract PoolManagerMigrator is IDexMigrator {
    address public immutable pm;

    constructor(address pm_) {
        pm = pm_;
    }

    function migrate(address token, uint256 tokenAmount, address, uint256) external payable {
        IERC20(token).transfer(pm, tokenAmount);
    }
}

/// Holder cashback must stay solvent and exact through any mix of post-
/// graduation activity: wallet transfers, self-transfers, sells into and buys
/// out of the pool, pool fee deposits and claims.
contract CashbackSolvencyTest is Test {
    Launchpad pad;
    address token;
    address pm = makeAddr("poolManager");
    address treasury = makeAddr("treasury");
    address[4] holders;

    function setUp() public {
        pad = new Launchpad(treasury, pm);
        pad.setMigrator(address(new PoolManagerMigrator(pm)));
        pad.authorizePoolFeeHook(address(this)); // this test deposits pool fees

        for (uint256 i = 0; i < 4; i++) {
            holders[i] = makeAddr(string(abi.encodePacked("holder", i)));
            vm.deal(holders[i], 100 ether);
        }
        vm.prank(holders[0]);
        token = pad.createToken("Solvent", "SOLV", 0, Launchpad.TokenMetadata("", "", "", "", "", ""), address(0), true);
        for (uint256 i = 1; i < 4; i++) {
            vm.prank(holders[i]);
            pad.buy{value: 0.5 ether}(token, 0);
        }
        vm.prank(holders[0]);
        pad.buy{value: 50 ether}(token, 0); // graduates, reserve parked at pm
        vm.deal(address(this), 1_000 ether);
    }

    function testFuzz_solventAndInSync(uint256 seed) public {
        for (uint256 step = 0; step < 40; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            address a = holders[seed % 4];
            address b = holders[(seed >> 8) % 4];
            uint256 op = (seed >> 16) % 6;
            uint256 bal = IERC20(token).balanceOf(a);
            uint256 amount = bal == 0 ? 0 : (seed >> 24) % (bal + 1);

            if (op == 0) {
                vm.prank(a);
                IERC20(token).transfer(b, amount); // may be a self-transfer when a == b
            } else if (op == 1) {
                vm.prank(a);
                IERC20(token).transfer(a, bal); // explicit self-transfer
            } else if (op == 2) {
                vm.prank(a);
                IERC20(token).transfer(pm, amount); // sell into the pool
            } else if (op == 3) {
                uint256 poolBal = IERC20(token).balanceOf(pm);
                vm.prank(pm);
                IERC20(token).transfer(a, poolBal == 0 ? 0 : (seed >> 24) % (poolBal + 1)); // buy out of it
            } else if (op == 4) {
                uint256 fee = ((seed >> 24) % 1 ether) + 1;
                pad.distributePoolFee{value: fee}(token, fee);
            } else if (pad.cashbackOf(token, a) > 0) {
                vm.prank(a);
                pad.claimCashback(token);
            }

            _checkInvariants();
        }
    }

    function _checkInvariants() internal view {
        uint256 outside =
            IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad)) - IERC20(token).balanceOf(pm);
        assertEq(pad.eligibleSupply(token), outside, "eligible supply in sync");

        uint256 owed = pad.creatorFees(treasury, address(0)) + pad.creatorFees(holders[0], address(0));
        for (uint256 i = 0; i < 4; i++) {
            owed += pad.cashbackOf(token, holders[i]);
        }
        owed += pad.cashbackOf(token, treasury);
        assertLe(owed, address(pad).balance, "every claim is backed");
    }

    function test_poolFeeOnlyFromAuthorizedHook() public {
        vm.deal(holders[1], 1 ether);
        vm.prank(holders[1]);
        vm.expectRevert(Launchpad.NotPoolFeeHook.selector);
        pad.distributePoolFee{value: 1 ether}(token, 1 ether);
    }

    function test_poolFeeRequiresGraduation() public {
        vm.prank(holders[1]);
        address fresh = pad.createToken("Fresh", "FRSH", 0, Launchpad.TokenMetadata("", "", "", "", "", ""), address(0), true);
        vm.expectRevert(Launchpad.NotYetGraduated.selector);
        pad.distributePoolFee{value: 1 ether}(fresh, 1 ether);
    }

    function test_poolManagerNeverAccrues() public {
        // the pool's reserve is outside the eligible supply: only wallets count
        uint256 held;
        for (uint256 i = 0; i < 4; i++) {
            held += IERC20(token).balanceOf(holders[i]);
        }
        assertEq(pad.eligibleSupply(token), held, "only wallets count");

        uint256 before = _claimable();
        pad.distributePoolFee{value: 1 ether}(token, 1 ether);
        // so the wallets receive the whole 80% pot, less wei-level rounding
        assertApproxEqAbs(_claimable() - before, 0.8 ether, 10);
        assertEq(pad.creatorFees(treasury, address(0)), 0.2 ether, "treasury share accrues pull-based");
    }

    function _claimable() internal view returns (uint256 total) {
        for (uint256 i = 0; i < 4; i++) {
            total += pad.cashbackOf(token, holders[i]);
        }
    }
}
