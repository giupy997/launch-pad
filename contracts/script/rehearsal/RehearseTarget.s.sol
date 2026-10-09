// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {UniV2Migrator} from "../../src/UniV2Migrator.sol";
import {MockCbLTC} from "../../test/mocks/MockCbLTC.sol";
import {ILaunchpadMigration} from "../../src/interfaces/ILaunchpadMigration.sol";
import {Keys} from "./Keys.sol";

/// The receiving side: a fresh v12 pad with a v2 migrator on the same mock
/// DEX, owned by the deployer. Quoted in the native coin (zkLTC on LitVM) or,
/// with DEST_QUOTE=erc20, in a mock cbLTC alone as on Base (the deployer and
/// alice holding plenty of it); with MIGRATE_AS=operator, alice is named its
/// migration operator, the part the deployer plays on Base v12.
contract RehearseTarget is Script {
    function run() external {
        string memory j = vm.readFile(Keys.SOURCE);
        address router = vm.parseJsonAddress(j, ".router");
        address deployer = vm.addr(Keys.DEPLOYER);
        bool erc20 = _is(vm.envOr("DEST_QUOTE", string("native")), "erc20");
        bool operator = _is(vm.envOr("MIGRATE_AS", string("owner")), "operator");
        address quote;
        vm.startBroadcast(Keys.DEPLOYER);
        Launchpad pad = new Launchpad(deployer);
        UniV2Migrator migrator = new UniV2Migrator(address(pad), router);
        pad.setMigrator(address(migrator));
        if (erc20) {
            MockCbLTC q = new MockCbLTC();
            pad.setQuoteAsset(address(q), 30e8);
            pad.setQuoteAsset(address(0), 0); // as on Base: cbLTC alone
            q.mint(deployer, 1_000_000e8);
            q.mint(vm.addr(Keys.ALICE), 1_000_000e8);
            quote = address(q);
        }
        if (operator) ILaunchpadMigration(address(pad)).setMigrationOperator(vm.addr(Keys.ALICE));
        vm.stopBroadcast();
        string memory t = "target";
        vm.serializeAddress(t, "migrator", address(migrator));
        vm.serializeAddress(t, "quote", quote);
        vm.writeJson(vm.serializeAddress(t, "launchpad", address(pad)), Keys.TARGET);
        console.log("target launchpad:", address(pad));
        console.log("quote:", erc20 ? "a mock cbLTC" : "the native coin", quote);
        if (operator) console.log("migration operator:", vm.addr(Keys.ALICE));
    }

    function _is(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
