// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// Zap flow against the real Uniswap pools on Robinhood Chain:
/// ETH -> USDG -> NVDA -> curve buy, one transaction, recipient = user.
/// Run with: RUN_FORK=true forge test --match-contract ZapRouterFork -vv
contract ZapRouterForkTest is Test {
    address constant SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    bool skipAll;
    Launchpad pad;
    ZapRouter zap;
    address treasury = makeAddr("treasury");
    address user = makeAddr("user");

    function setUp() public {
        if (!vm.envOr("RUN_FORK", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        pad = new Launchpad(treasury, address(0));
        pad.setQuoteAsset(NVDA, 24e18);
        zap = new ZapRouter(address(pad), SWAP_ROUTER, WETH);
        vm.deal(user, 10 ether);
    }

    function test_fork_zapBuyEthToNvdaCurve() public {
        if (skipAll) return;

        vm.prank(user);
        address token = pad.createToken(
            "Nvidia Fan", "NFAN", 0,
            Launchpad.TokenMetadata("", "", "", "", "", ""), NVDA, false
        );

        // WETH -500-> USDG -500-> NVDA
        bytes memory path = abi.encodePacked(WETH, uint24(500), USDG, uint24(500), NVDA);

        vm.prank(user);
        zap.zapBuy{value: 0.1 ether}(token, path, 0, 0);

        // user (not the router) holds the curve tokens
        assertGt(LaunchToken(token).balanceOf(user), 0, "user got tokens");
        assertEq(LaunchToken(token).balanceOf(address(zap)), 0, "router keeps nothing");

        // curve accounted in NVDA and cashback credited to the user
        (,, uint256 realQuote, uint256 sold,,,) = pad.curves(token);
        assertGt(realQuote, 0, "curve holds NVDA");
        assertGt(sold, 0);
        assertGt(pad.cashbackOf(token, user), 0, "cashback to user");
        assertEq(pad.cashbackOf(token, address(zap)), 0, "no cashback to router");

        // router holds no residue of any hop
        assertEq(IERC20(WETH).balanceOf(address(zap)), 0);
        assertEq(IERC20(USDG).balanceOf(address(zap)), 0);
        assertEq(IERC20(NVDA).balanceOf(address(zap)), 0);

        // wrong path (ends at USDG, not the quote) must revert
        bytes memory badPath = abi.encodePacked(WETH, uint24(500), USDG);
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert(ZapRouter.PathMismatch.selector);
        zap.zapBuy{value: 0.05 ether}(token, badPath, 0, 0);
    }
}
