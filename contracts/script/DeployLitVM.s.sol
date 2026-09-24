// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";

/// LitVM (Litecoin's EVM layer 2, Arbitrum Orbit): the Launchpad quoted in
/// native zkLTC, plus — when UNIV2_ROUTER is set — a Uniswap v2 graduation
/// adapter (LitVM's DEXes are v2 forks; there is no v4 PoolManager, so
/// holder rewards stop at graduation there, like on GIWA).
///
///   cd contracts && source .env && \
///   UNIV2_ROUTER=0x... forge script script/DeployLitVM.s.sol --rpc-url litvm_testnet \
///     --private-key "$PRIVATE_KEY" --broadcast
contract DeployLitVM is Script {
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    function run() external {
        address treasury = vm.envOr("TREASURY", msg.sender);
        address router = vm.envOr("UNIV2_ROUTER", address(0));

        vm.startBroadcast();
        Launchpad pad = new Launchpad(treasury, address(0));
        if (router != address(0)) {
            UniV2Migrator migrator = new UniV2Migrator(address(pad), router);
            pad.setMigrator(address(migrator));
            console.log("UniV2Migrator:", address(migrator));
        }
        vm.stopBroadcast();

        console.log("Launchpad:    ", address(pad));
        console.log("Treasury:     ", treasury);
        console.log("Deploy block: ", block.number);
        if (router == address(0)) console.log("No UNIV2_ROUTER: graduation stays manual until setMigrator");
        if (MULTICALL3.code.length == 0) {
            console.log("No Multicall3 on this chain: the web app falls back to single reads (fine for a testnet)");
        }
    }
}
