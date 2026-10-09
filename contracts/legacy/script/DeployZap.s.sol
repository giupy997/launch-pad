// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ZapRouter} from "../src/ZapRouter.sol";

/// Deploys the ETH zap router for Robinhood Chain. Requires LAUNCHPAD env var.
contract DeployZap is Script {
    address constant SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function run() external {
        address launchpad = vm.envAddress("LAUNCHPAD");
        vm.startBroadcast();
        ZapRouter zap = new ZapRouter(launchpad, SWAP_ROUTER, WETH);
        vm.stopBroadcast();
        console.log("ZapRouter deployed at:", address(zap));
    }
}
