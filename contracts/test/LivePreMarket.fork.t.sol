// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {ZapRouter} from "../src/ZapRouter.sol";

/// Checks the LIVE pre-market flow on Robinhood Chain mainnet (fork
/// simulation — no real funds spent): launch a token paired with the OPENAI
/// pre-market, buy it with plain ETH in one transaction through the curve
/// zap, and sell back.
/// Run with: RUN_FORK_LIVE=true forge test --match-contract LivePreMarket -vv
contract LivePreMarketForkTest is Test {
    Launchpad constant PAD = Launchpad(0x39fE527714571FE9EA35c4e19C5Bc66503f6F777);
    ZapRouter constant ZAP = ZapRouter(payable(0x6b52d9C2631f216fe3076149C0A8cb36864a9D81));
    address constant OPENAI = 0xD1f2f5CdC507b76e72B245EC32eDBED68babE50F;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;

    bool skipAll;
    address user = makeAddr("user");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        vm.deal(user, 20 ether);
    }

    function test_livePreMarketPairAndCurveZap() public {
        if (skipAll) return;

        // the pre-market is a live pair asset: whitelisted and transferable
        assertGt(PAD.quoteVirtualReserve(OPENAI), 0, "OPENAI whitelisted");
        assertTrue(LaunchToken(OPENAI).transferable(), "transferable pre-graduation");
        assertTrue(PAD.feesToHolders(OPENAI), "rewards mode");

        // anyone can launch a token paired with it
        vm.prank(user);
        address token = PAD.createToken(
            "OpenAI Fan", "OFAN", 0,
            Launchpad.TokenMetadata("", "", "", "", "", "paired with the OPENAI pre-market"),
            OPENAI, false
        );
        (,,,,,, address quote) = PAD.curves(token);
        assertEq(quote, OPENAI, "curve quoted in the pre-market");

        // and buy it paying plain ETH, in ONE transaction, with no pool.
        // 0.1 ETH buys ~77M OPENAI, below the ~160M this curve needs to
        // graduate, so the sell leg below still has an open curve to hit.
        vm.prank(user);
        ZAP.zapBuyCurve{value: 0.1 ether}(token, 0, 0);
        assertGt(LaunchToken(token).balanceOf(user), 0, "tokens received");
        assertEq(address(ZAP).balance, 0, "router holds no ETH");
        assertEq(LaunchToken(OPENAI).balanceOf(address(ZAP)), 0, "router holds no quote");
        // the cashback earned while the router held the pre-market is claimed
        // and forwarded, never stranded
        assertEq(PAD.cashbackOf(OPENAI, address(ZAP)), 0, "router cashback claimed");

        // selling the paired token pays out in the pre-market asset
        uint256 bal = LaunchToken(token).balanceOf(user);
        uint256 preBefore = LaunchToken(OPENAI).balanceOf(user);
        vm.startPrank(user);
        LaunchToken(token).approve(address(PAD), bal);
        PAD.sell(token, bal, 0);
        vm.stopPrank();
        assertGt(LaunchToken(OPENAI).balanceOf(user), preBefore, "sell paid in OPENAI");
    }

    function test_liveStockZapStillWorks() public {
        if (skipAll) return;

        // a stock-paired curve still buys with ETH through the Uniswap route
        vm.prank(user);
        address token = PAD.createToken(
            "Nvidia Fan", "NFAN", 0,
            Launchpad.TokenMetadata("", "", "", "", "", ""), NVDA, false
        );
        // WETH -500-> USDG -500-> NVDA (the route in web/lib/config.ts)
        bytes memory path = abi.encodePacked(
            address(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73), uint24(500),
            address(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168), uint24(500),
            NVDA
        );
        vm.prank(user);
        ZAP.zapBuy{value: 0.2 ether}(token, path, 0, 0);
        assertGt(LaunchToken(token).balanceOf(user), 0, "stock-paired zap works");
    }
}
