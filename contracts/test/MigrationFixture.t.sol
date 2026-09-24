// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {MigrateFromLedger} from "../script/MigrateFromLedger.s.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

/// End to end: the file `litecoin/migration-snapshot.ts` writes from a real
/// ledger snapshot (here the demo one) goes through the migration script
/// into a fresh Launchpad, and every holder ends up with their balance.
contract MigrationFixtureTest is Test {
    function test_demoLedgerMigratesEndToEnd() public {
        string memory json = vm.readFile("test/fixtures/migration-demo.json");
        MigrateFromLedger script = new MigrateFromLedger();
        MigrateFromLedger.Coin[] memory coins = script.load(json);
        assertEq(coins.length, 3, "the demo ledger has three coins");

        Launchpad pad = new Launchpad(makeAddr("treasury"), address(0));
        pad.transferOwnership(address(script));
        uint256 total;
        for (uint256 i = 0; i < coins.length; i++) {
            total += coins[i].realQuote;
        }
        vm.deal(address(script), total);

        script.migrateAll(pad, coins);

        assertEq(pad.tokenCount(), 3);
        assertEq(address(pad).balance, total, "every curve's reserve is in the contract");
        for (uint256 i = 0; i < coins.length; i++) {
            address token = pad.allTokens(i);
            (uint256 vEth, uint256 vToken, uint256 realEth, uint256 sold,, address creator,) = pad.curves(token);
            assertEq(vEth, coins[i].virtualQuote + coins[i].realQuote);
            assertEq(vToken, pad.VIRTUAL_TOKEN() - coins[i].sold);
            assertEq(realEth, coins[i].realQuote);
            assertEq(sold, coins[i].sold);
            assertEq(creator, coins[i].creator);
            assertEq(pad.migrationPending(token), 0);
            uint256 delivered;
            for (uint256 j = 0; j < coins[i].holders.length; j++) {
                assertEq(IERC20(token).balanceOf(coins[i].holders[j]), coins[i].balances[j]);
                delivered += coins[i].balances[j];
            }
            assertEq(delivered, coins[i].sold, "the ledger's sold amount is exactly what was delivered");
            assertEq(pad.feesToHolders(token), coins[i].feesToHolders);
        }
    }
}
