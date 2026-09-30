// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {UniV2Migrator} from "../../src/UniV2Migrator.sol";
import {Keys} from "./Keys.sol";

/// The receiving side: a fresh pad quoted in the native coin (zkLTC on LitVM),
/// with a v2 migrator on the same mock DEX, owned by the deployer.
contract RehearseTarget is Script {
    function run() external {
        string memory j = vm.readFile(Keys.SOURCE);
        address router = vm.parseJsonAddress(j, ".router");
        vm.startBroadcast(Keys.DEPLOYER);
        Launchpad pad = new Launchpad(vm.addr(Keys.DEPLOYER));
        UniV2Migrator migrator = new UniV2Migrator(address(pad), router);
        pad.setMigrator(address(migrator));
        vm.stopBroadcast();
        string memory t = "target";
        vm.serializeAddress(t, "migrator", address(migrator));
        vm.writeJson(vm.serializeAddress(t, "launchpad", address(pad)), Keys.TARGET);
        console.log("target launchpad:", address(pad));
    }
}
