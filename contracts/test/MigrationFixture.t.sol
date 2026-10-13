// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {MigrateFromLedger} from "../script/MigrateFromLedger.s.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// End to end: the file `parked/litecoin/migration-snapshot.ts` writes from a
/// real ledger snapshot (here the demo one) goes through the migration script
/// into a fresh Launchpad, and every holder ends up with their balance.
contract MigrationFixtureTest is Test {
    function test_demoLedgerMigratesEndToEnd() public {
        string memory json = vm.readFile("test/fixtures/migration-demo.json");
        MigrateFromLedger script = new MigrateFromLedger();
        MigrateFromLedger.Coin[] memory coins = script.load(json);
        assertEq(coins.length, 3, "the demo ledger has three coins");

        Launchpad pad = new Launchpad(makeAddr("treasury"));
        pad.transferOwnership(address(script));
        uint256 total;
        for (uint256 i = 0; i < coins.length; i++) {
            total += coins[i].realQuote;
        }
        vm.deal(address(script), total);

        script.ensureRoot(pad, json);
        assertEq(
            pad.migrationRoot(), bytes32(uint256(0x9bb8b9e073b6cde9632ba848277ca117db3725f2e8ee48a3d46d176d6616d433))
        );
        assertEq(pad.migrationFreezeHeight(), 3_600_090);
        address[] memory tokens = script.migrateAll(pad, coins);
        assertEq(tokens.length, 3);
        // running it again changes nothing: every ticker exists, every holder was delivered
        address[] memory again = script.migrateAll(pad, coins);
        for (uint256 i = 0; i < tokens.length; i++) {
            assertEq(again[i], tokens[i]);
        }

        assertEq(pad.tokenCount(), 3);
        assertEq(address(pad).balance, total, "every curve's and pool's reserve is in the contract");
        uint256 pooled;
        for (uint256 i = 0; i < coins.length; i++) {
            if (_checkCoin(pad, pad.allTokens(i), coins[i])) pooled++;
        }
        assertGt(pooled, 0, "the demo ledger has a coin that graduated into its pool");
    }

    /// The coin on the Launchpad as the ledger left it; true if it had graduated there.
    function _checkCoin(Launchpad pad, address token, MigrateFromLedger.Coin memory coin)
        internal
        view
        returns (bool isPooled)
    {
        (uint256 vEth, uint256 vToken, uint256 realEth, uint256 sold, bool graduated, address creator,) =
            pad.curves(token);
        assertEq(vEth, coin.virtualQuote + coin.realQuote);
        assertEq(realEth, coin.realQuote);
        assertEq(creator, coin.creator);
        assertEq(pad.migrationPending(token), 0);
        assertEq(pad.feesToHolders(token), coin.holdersBps != 0);
        assertEq(pad.burned(token), coin.burned);
        assertEq(pad.burnPot(token) + pad.liquidityPot(token), coin.burnPot + coin.liquidityPot);
        isPooled = coin.poolToken != 0;
        if (isPooled) {
            // graduated on the ledger: its holders own the supply less the pool
            assertTrue(graduated);
            assertEq(sold, pad.CURVE_SUPPLY());
            assertEq(vToken, pad.VIRTUAL_TOKEN() - pad.CURVE_SUPPLY());
            assertEq(coin.sold + coin.poolToken, pad.TOTAL_SUPPLY());
            assertEq(pad.migratedPoolTokens(token), coin.poolToken);
            assertEq(IERC20(token).balanceOf(address(pad)), coin.poolToken, "the pool waits for the DEX");
        } else {
            assertFalse(graduated);
            assertEq(vToken, pad.VIRTUAL_TOKEN() - coin.sold);
            assertEq(sold, coin.sold);
        }
        uint256 delivered;
        for (uint256 j = 0; j < coin.holders.length; j++) {
            assertEq(IERC20(token).balanceOf(coin.holders[j]), coin.balances[j]);
            delivered += coin.balances[j];
        }
        assertEq(delivered, coin.sold - coin.burned, "what the holders own is exactly what was delivered");
    }

    /// A creator's description that looks like an address or a hash is a string all the
    /// same: the typed parse keeps it, where type inference would have refused the file.
    function test_loadKeepsHexShapedStrings() public {
        string memory json = vm.readFile("test/fixtures/migration-demo.json");
        MigrateFromLedger script = new MigrateFromLedger();
        string memory hexed =
            vm.replace(json, "\"name\": \"Chikun\"", "\"name\": \"0x2F36cdc2ac6DEd9f99B2d2Dc1c1EDF8d7e8A3471\"");
        MigrateFromLedger.Coin[] memory coins = script.load(hexed);
        assertEq(coins[0].name, "0x2F36cdc2ac6DEd9f99B2d2Dc1c1EDF8d7e8A3471");
        string memory hashed = vm.replace(
            json,
            "\"description\": \"\"",
            "\"description\": \"0x9bb8b9e073b6cde9632ba848277ca117db3725f2e8ee48a3d46d176d6616d433\""
        );
        coins = script.load(hashed);
        assertEq(coins[0].description, "0x9bb8b9e073b6cde9632ba848277ca117db3725f2e8ee48a3d46d176d6616d433");
        // and the tree follows the strings: another description, another root
        assertTrue(script.treeRoot(coins, address(0)) != script.treeRoot(script.load(json), address(0)));
    }

    /// A dry-run file (unfrozen, or scaled) is refused: its root would be committed for good.
    function test_refusesADryRunFile() public {
        string memory json = vm.readFile("test/fixtures/migration-demo.json");
        MigrateFromLedger script = new MigrateFromLedger();
        script.refuseDryRun(json); // the demo ledger: frozen, unscaled
        string memory dry =
            vm.replace(json, "\"freezeHeight\": 3600090,", "\"freezeHeight\": 3600090, \"dryRun\": true,");
        vm.expectRevert(
            bytes("a dry-run file (unfrozen, or scaled): not for a migration. ALLOW_DRY_RUN=true for a rehearsal")
        );
        script.refuseDryRun(dry);
        string memory scaled =
            vm.replace(json, "\"freezeHeight\": 3600090,", "\"freezeHeight\": 3600090, \"scale\": 10,");
        vm.expectRevert(
            bytes("a dry-run file (unfrozen, or scaled): not for a migration. ALLOW_DRY_RUN=true for a rehearsal")
        );
        script.refuseDryRun(scaled);
        vm.setEnv("ALLOW_DRY_RUN", "true");
        script.refuseDryRun(dry); // a rehearsal says so
        vm.setEnv("ALLOW_DRY_RUN", "false");
    }
}
