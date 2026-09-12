// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {IDexMigrator} from "../src/interfaces/IDexMigrator.sol";

contract NoopMigrator is IDexMigrator {
    function migrate(address, uint256, address, uint256) external payable {}
}

/// Unit tests for ZapRouter.zapBuyCurve — the DEX-free zap that routes
/// ETH -> pre-market curve -> paired token in one transaction.
contract ZapRouterCurveTest is Test {
    Launchpad pad;
    ZapRouter zap;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address pre;
    address token;

    function setUp() public {
        pad = new Launchpad(treasury);
        pad.setMigrator(address(new NoopMigrator()));
        // swapRouter/weth are unused by the curve zap: dummies are fine
        zap = new ZapRouter(address(pad), makeAddr("swapRouter"), makeAddr("weth"));

        pre = pad.createPreMarket(
            "OpenAI Pre-Market", "OPENAI",
            Launchpad.TokenMetadata("", "", "", "", "", ""), 50_000_000e18
        );
        vm.prank(alice);
        token = pad.createToken(
            "OpenAI Fan", "OFAN", 0,
            Launchpad.TokenMetadata("", "", "", "", "", ""), pre, false
        );
        vm.deal(bob, 100 ether);
    }

    function test_zapBuyCurve() public {
        vm.prank(bob);
        zap.zapBuyCurve{value: 0.5 ether}(token, 0, 0);

        assertGt(LaunchToken(token).balanceOf(bob), 0, "bob got paired tokens");
        // nothing stuck on the router
        assertEq(address(zap).balance, 0, "no ETH stuck");
        assertEq(LaunchToken(pre).balanceOf(address(zap)), 0, "no pre stuck");
        assertEq(LaunchToken(token).balanceOf(address(zap)), 0, "no tokens stuck");
    }

    function test_zapBuyCurveSlippageGuards() public {
        vm.prank(bob);
        vm.expectRevert(Launchpad.Slippage.selector);
        zap.zapBuyCurve{value: 0.5 ether}(token, type(uint256).max, 0);

        vm.prank(bob);
        vm.expectRevert(Launchpad.Slippage.selector);
        zap.zapBuyCurve{value: 0.5 ether}(token, 0, type(uint256).max);
    }

    function test_zapBuyCurveRevertsOnEthCurve() public {
        vm.prank(alice);
        address ethToken = pad.createToken(
            "Plain", "PLAIN", 0,
            Launchpad.TokenMetadata("", "", "", "", "", ""), address(0), false
        );
        vm.prank(bob);
        vm.expectRevert(ZapRouter.NotQuoteCurve.selector);
        zap.zapBuyCurve{value: 0.1 ether}(ethToken, 0, 0);
    }

    function test_zapBuyCurveRefundsGraduatingSurplus() public {
        // buy way past the pre-market curve's graduation point: the surplus
        // ETH refund lands on the router and must be forwarded to the user
        uint256 before = bob.balance;
        vm.prank(bob);
        zap.zapBuyCurve{value: 50 ether}(token, 0, 0);

        (,,,, bool preGraduated,,) = pad.curves(pre);
        assertTrue(preGraduated, "pre-market graduated by the zap");
        assertGt(LaunchToken(token).balanceOf(bob), 0);
        assertEq(address(zap).balance, 0, "no ETH stuck");
        // curve only needed ~4 ETH: most of the 50 came back to bob
        assertGt(bob.balance, before - 6 ether, "surplus refunded to user");
    }
}
