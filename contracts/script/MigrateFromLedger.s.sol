// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";

/// Re-creates every coin of a frozen Notus ledger (Notus on Litecoin) on an
/// EVM Launchpad, from the file `node litecoin/migration-snapshot.ts` wrote.
/// The broadcaster must own the Launchpad and hold the bridged LTC: each coin
/// takes exactly its curve's reserve as msg.value.
///
///   LAUNCHPAD=0x... MIGRATION_FILE=litecoin/migration/test-3600085.json \
///   forge script script/MigrateFromLedger.s.sol --rpc-url litvm_testnet \
///     --private-key "$PRIVATE_KEY" --broadcast
contract MigrateFromLedger is Script {
    /// One coin as the file lists it. Field order is alphabetical because
    /// that is how vm.parseJson lays a JSON object out.
    struct Coin {
        uint256[] balances;
        address creator;
        bool feesToHolders;
        address[] holders;
        string logo;
        string name;
        uint256 realQuote;
        uint256 sold;
        string symbol;
        uint256 virtualQuote;
    }

    /// Holders delivered per transaction: ~60k gas each keeps a batch well
    /// inside any block.
    uint256 public constant BATCH = 150;

    function run() external {
        Launchpad pad = Launchpad(vm.envAddress("LAUNCHPAD"));
        Coin[] memory coins = load(vm.readFile(vm.envString("MIGRATION_FILE")));
        vm.startBroadcast();
        migrateAll(pad, coins);
        vm.stopBroadcast();
    }

    function load(string memory json) public pure returns (Coin[] memory coins) {
        coins = abi.decode(vm.parseJson(json, ".coins"), (Coin[]));
    }

    function migrateAll(Launchpad pad, Coin[] memory coins) public {
        for (uint256 i = 0; i < coins.length; i++) {
            address token = migrateOne(pad, coins[i]);
            console.log(coins[i].symbol, "->", token);
        }
    }

    function migrateOne(Launchpad pad, Coin memory c) public returns (address token) {
        require(c.holders.length == c.balances.length, "holders/balances mismatch");
        uint256 first = c.holders.length < BATCH ? c.holders.length : BATCH;
        (address[] memory h, uint256[] memory b) = _slice(c, 0, first);
        Launchpad.TokenMetadata memory meta;
        meta.logoURI = c.logo;
        meta.description = "Migrated from Notus on Litecoin";
        token = pad.migrateToken{value: c.realQuote}(
            Launchpad.LedgerCoin({
                name: c.name,
                symbol: c.symbol,
                meta: meta,
                creator: c.creator,
                feesToHolders: c.feesToHolders,
                virtualQuote: c.virtualQuote,
                sold: c.sold
            }),
            h,
            b
        );
        for (uint256 at = first; at < c.holders.length; at += BATCH) {
            uint256 end = at + BATCH < c.holders.length ? at + BATCH : c.holders.length;
            (h, b) = _slice(c, at, end);
            pad.migrateBalances(token, h, b);
        }
    }

    function _slice(Coin memory c, uint256 from, uint256 to)
        internal
        pure
        returns (address[] memory h, uint256[] memory b)
    {
        h = new address[](to - from);
        b = new uint256[](to - from);
        for (uint256 i = from; i < to; i++) {
            h[i - from] = c.holders[i];
            b[i - from] = c.balances[i];
        }
    }

    receive() external payable {}
}
