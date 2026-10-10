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
        assertEq(pad.migrationRoot(), bytes32(uint256(0x28bf69752873a3620128cb7ad5a7b2996f96650d0a165416fdc1980d5651721b)));
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
}
