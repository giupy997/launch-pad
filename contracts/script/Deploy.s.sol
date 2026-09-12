// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";

/// Deploys the Launchpad. The treasury defaults to the deployer. POOL_MANAGER
/// is the chain's Uniswap v4 PoolManager (its balances are excluded from
/// holder cashback); leave it unset on chains without v4. The DEX migrator is
/// wired afterwards (DeployV4Hook.s.sol on Robinhood Chain).
contract Deploy is Script {
    function run() external {
        address treasury = vm.envOr("TREASURY", msg.sender);
        address poolManager = vm.envOr("POOL_MANAGER", address(0));

        vm.startBroadcast();
        Launchpad pad = new Launchpad(treasury, poolManager);
        vm.stopBroadcast();

        console.log("Launchpad deployed at:", address(pad));
        console.log("Treasury:", treasury);
        console.log("Pool manager:", poolManager);
    }
}
