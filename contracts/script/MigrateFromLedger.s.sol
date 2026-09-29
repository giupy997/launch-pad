// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";

/// Re-creates every coin of a frozen Notus ledger (Notus on Litecoin) on an
/// EVM Launchpad, from the file `node litecoin/migration-snapshot.ts` wrote.
/// The broadcaster must own the Launchpad and hold the bridged LTC: each coin
/// takes exactly its curve's reserve as msg.value.
///
/// Safe to run again after a failure: the snapshot's root is set on the
/// Launchpad once, a coin whose token already exists is not created twice,
/// and holders already delivered are skipped. When it is done it writes the
/// ticker → token map the site reads (copy it to web/public/litecoin/migrated.json).
///
///   LAUNCHPAD=0x... MIGRATION_FILE=../litecoin/migration/main-<freeze>.json \
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
        uint256 poolToken;
        uint256 realQuote;
        uint256 sold;
        string symbol;
        uint256 virtualQuote;
    }

    /// Holders delivered per transaction: ~35k gas each keeps a batch well
    /// inside any block.
    uint256 public constant BATCH = 150;

    function run() external {
        Launchpad pad = Launchpad(vm.envAddress("LAUNCHPAD"));
        string memory file = vm.envString("MIGRATION_FILE");
        string memory json = vm.readFile(file);
        Coin[] memory coins = load(json);
        vm.startBroadcast();
        ensureRoot(pad, json);
        address[] memory tokens = migrateAll(pad, coins);
        vm.stopBroadcast();
        writeMigrated(pad, coins, tokens, file);
    }

    function load(string memory json) public pure returns (Coin[] memory coins) {
        coins = abi.decode(vm.parseJson(json, ".coins"), (Coin[]));
    }

    /// The snapshot this file came from, committed on the Launchpad before
    /// any coin: once set, every later run must be from the same snapshot.
    function ensureRoot(Launchpad pad, string memory json) public {
        bytes32 root = vm.parseBytes32(string.concat("0x", vm.parseJsonString(json, ".stateRoot")));
        uint256 freeze = vm.parseJsonUint(json, ".freezeHeight");
        string memory network = vm.parseJsonString(json, ".network");
        if (pad.migrationRoot() == bytes32(0)) {
            pad.setMigrationRoot(root, freeze, network);
            console.log("migration root set:", vm.toString(root));
        } else {
            require(pad.migrationRoot() == root, "the Launchpad holds another snapshot's root");
        }
    }

    function migrateAll(Launchpad pad, Coin[] memory coins) public returns (address[] memory tokens) {
        tokens = new address[](coins.length);
        for (uint256 i = 0; i < coins.length; i++) {
            tokens[i] = migrateOne(pad, coins[i]);
            console.log(coins[i].symbol, "->", tokens[i]);
        }
    }

    /// Create the coin if this ticker has no token yet, then deliver every
    /// holder not delivered already, BATCH at a time.
    function migrateOne(Launchpad pad, Coin memory c) public returns (address token) {
        require(c.holders.length == c.balances.length, "holders/balances mismatch");
        token = pad.migratedTicker(keccak256(bytes(c.symbol)));
        uint256 from = 0;
        if (token == address(0)) {
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
                    sold: c.sold,
                    poolToken: c.poolToken
                }),
                h,
                b
            );
            from = first;
        } else {
            console.log(c.symbol, "already migrated, delivering what is left");
        }
        while (from < c.holders.length && pad.migrationPending(token) != 0) {
            (address[] memory h, uint256[] memory b, uint256 next) = _undelivered(pad, token, c, from);
            from = next;
            if (h.length != 0) pad.migrateBalances(token, h, b);
        }
    }

    /// Up to BATCH holders from `from` on that the Launchpad has not delivered yet.
    function _undelivered(Launchpad pad, address token, Coin memory c, uint256 from)
        internal
        view
        returns (address[] memory h, uint256[] memory b, uint256 next)
    {
        address[] memory hs = new address[](BATCH);
        uint256[] memory bs = new uint256[](BATCH);
        uint256 n = 0;
        next = from;
        while (next < c.holders.length && n < BATCH) {
            if (!pad.migrationDelivered(token, c.holders[next])) {
                hs[n] = c.holders[next];
                bs[n] = c.balances[next];
                n++;
            }
            next++;
        }
        h = new address[](n);
        b = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            h[i] = hs[i];
            b[i] = bs[i];
        }
    }

    /// The ticker → token map the site serves as /litecoin/migrated.json,
    /// written next to the migration file.
    function writeMigrated(Launchpad pad, Coin[] memory coins, address[] memory tokens, string memory file) public {
        string memory tokensKey = "tokens";
        string memory tokensJson = "";
        for (uint256 i = 0; i < coins.length; i++) {
            tokensJson = vm.serializeAddress(tokensKey, coins[i].symbol, tokens[i]);
        }
        string memory outKey = "out";
        vm.serializeString(outKey, "network", pad.migrationNetwork());
        vm.serializeUint(outKey, "freezeHeight", pad.migrationFreezeHeight());
        vm.serializeBytes32(outKey, "stateRoot", pad.migrationRoot());
        vm.serializeAddress(outKey, "launchpad", address(pad));
        string memory out = vm.serializeString(outKey, "tokens", tokensJson);
        string memory path = string.concat(file, ".migrated.json");
        vm.writeJson(out, path);
        console.log("ticker -> token map written to", path);
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
