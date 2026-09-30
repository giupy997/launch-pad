// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SlipstreamZapRouter} from "../src/SlipstreamZapRouter.sol";

/// Base: the ETH zap for cbLTC through Aerodrome Slipstream, whose cbLTC/WETH
/// pool (0x2006…C88A, tick spacing 200, "CL200 · 0.25%") holds the liquidity
/// PancakeSwap's does not. The router below is the one bound to the CL factory
/// that made that pool (0x5e7BB104…): Slipstream has three factories, each
/// with a router of its own, and a router only reaches its own pools.
///
///   cd contracts && source .env && \
///   LAUNCHPAD=0x... forge script script/DeployZapSlipstream.s.sol --rpc-url base \
///     --private-key "$PRIVATE_KEY" --broadcast
///
/// Then in web/lib/config.ts: ZAP_ROUTER = this address, UNISWAP_QUOTER = the
/// Slipstream QuoterV2 0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0 (QuoterV2's
/// ABI, paths with tick spacings), cbLTC's zapFees = [200].
contract DeployZapSlipstream is Script {
    /// Aerodrome Slipstream SwapRouter (initial deployment, CL factory 0x5e7BB104…).
    address constant SWAP_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        address launchpad = vm.envAddress("LAUNCHPAD");
        require(SWAP_ROUTER.code.length > 0, "no Slipstream router at its address: is this Base?");
        vm.startBroadcast();
        SlipstreamZapRouter zap = new SlipstreamZapRouter(launchpad, SWAP_ROUTER, WETH);
        vm.stopBroadcast();
        console.log("SlipstreamZapRouter:", address(zap));
        console.log("Launchpad:          ", launchpad);
        console.log("Deploy block:       ", block.number);
    }
}
