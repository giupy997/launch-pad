// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "openzeppelin-contracts/contracts/governance/TimelockController.sol";
import {Launchpad} from "../src/Launchpad.sol";

/// Re-creates every coin of a frozen Notus ledger (Notus on Litecoin) on an
/// EVM Launchpad, from the file `node litecoin/migration-snapshot.ts` wrote.
/// The broadcaster holds the bridged LTC: each coin takes exactly its curve's
/// reserve as msg.value.
///
/// Who owns the Launchpad decides how it runs:
///   MODE=direct    the broadcaster is the owner (a rehearsal pad): everything runs now.
///   MODE=schedule  the owner is a TimelockController (TIMELOCK=0x...): the calls
///                  still to be made are scheduled as batches, in the open, and can
///                  run once the timelock's delay has passed…
///   MODE=execute   …when this runs them (anyone may; the broadcaster sends the LTC).
/// A coin with more holders than one batch carries takes a second round of
/// schedule + execute for the rest: its token address exists only after the first.
///
/// Safe to run again after a failure: the snapshot's root is set once, a coin
/// whose token exists is not created twice, holders already delivered are
/// skipped, an operation already scheduled is not scheduled twice. When every
/// coin has its token and its holders, it writes the ticker → token map the
/// site reads (copy it to web/public/litecoin/migrated.json).
///
///   LAUNCHPAD=0x... MIGRATION_FILE=../litecoin/migration/main-<freeze>.json \
///   [MODE=schedule|execute TIMELOCK=0x...] \
///   forge script script/MigrateFromLedger.s.sol --rpc-url litvm_testnet \
///     --account notus --broadcast
contract MigrateFromLedger is Script {
    /// One coin as the file lists it. Field order is alphabetical because
    /// that is how vm.parseJson lays a JSON object out.
    struct Coin {
        uint256[] balances;
        uint256 burnBps;
        uint256 burnPot;
        uint256 burned;
        uint256 buyTaxBps;
        address creator;
        uint256 creatorBps;
        address[] holders;
        uint256 holdersBps;
        uint256 liquidityBps;
        uint256 liquidityPot;
        string logo;
        string name;
        uint256 poolToken;
        uint256 realQuote;
        uint256 sellTaxBps;
        uint256 sold;
        string symbol;
        uint256 virtualQuote;
    }

    /// One call the migration makes on the Launchpad.
    struct Call {
        uint256 value;
        bytes data;
    }

    /// One timelock operation: a few calls, executed in one transaction.
    struct Op {
        address[] targets;
        uint256[] values;
        bytes[] payloads;
        bytes32 salt;
    }

    /// Holders delivered per transaction: ~35k gas each keeps a batch well
    /// inside any block.
    uint256 public constant BATCH = 150;
    /// Calls per timelock operation: a migrateToken with a full batch is
    /// about 8M gas, so three keep an operation inside any block.
    uint256 public constant CALLS_PER_OP = 3;

    function run() external {
        Launchpad pad = Launchpad(vm.envAddress("LAUNCHPAD"));
        string memory file = vm.envString("MIGRATION_FILE");
        string memory json = vm.readFile(file);
        Coin[] memory coins = load(json);
        string memory mode = vm.envOr("MODE", string("direct"));
        if (_is(mode, "direct")) {
            vm.startBroadcast();
            ensureRoot(pad, json);
            migrateAll(pad, coins);
            vm.stopBroadcast();
        } else {
            TimelockController timelock = TimelockController(payable(vm.envAddress("TIMELOCK")));
            require(pad.owner() == address(timelock), "the timelock does not own the Launchpad");
            Op[] memory ops = plan(pad, json, coins);
            vm.startBroadcast();
            if (_is(mode, "schedule")) scheduleAll(timelock, ops);
            else if (_is(mode, "execute")) executeAll(timelock, ops);
            else revert("MODE must be direct, schedule or execute");
            vm.stopBroadcast();
        }
        if (allMigrated(pad, coins)) writeMigrated(pad, coins, file);
        else console.log("not every coin has its token and its holders yet: the map is written when they all do");
    }

    function load(string memory json) public pure returns (Coin[] memory coins) {
        coins = abi.decode(vm.parseJson(json, ".coins"), (Coin[]));
    }

    function rootOf(string memory json) public pure returns (bytes32 root, uint256 freeze) {
        root = vm.parseBytes32(string.concat("0x", vm.parseJsonString(json, ".stateRoot")));
        freeze = vm.parseJsonUint(json, ".freezeHeight");
    }

    // ------------------------------------------------------------ direct

    /// The snapshot this file came from, committed on the Launchpad before
    /// any coin: once set, every later run must be from the same snapshot.
    function ensureRoot(Launchpad pad, string memory json) public {
        (bytes32 root, uint256 freeze) = rootOf(json);
        if (pad.migrationRoot() == bytes32(0)) {
            pad.setMigrationRoot(root, freeze);
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
            token = pad.migrateToken{value: _value(c)}(_ledgerCoin(c), h, b);
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

    // ---------------------------------------------------------- timelock

    /// The calls still to be made, as the Launchpad stands now, grouped into
    /// timelock operations. Deterministic: run before scheduling and again
    /// before executing, on the same state, it names the same operations.
    function plan(Launchpad pad, string memory json, Coin[] memory coins) public view returns (Op[] memory ops) {
        (bytes32 root, uint256 freeze) = rootOf(json);
        bool needRoot = pad.migrationRoot() == bytes32(0);
        if (!needRoot) require(pad.migrationRoot() == root, "the Launchpad holds another snapshot's root");

        // every call, root first
        Call[] memory calls = new Call[](_maxCalls(coins) + 1);
        uint256 n = 0;
        if (needRoot) calls[n++] = Call(0, abi.encodeCall(pad.setMigrationRoot, (root, freeze)));
        for (uint256 i = 0; i < coins.length; i++) {
            n = _coinCalls(pad, coins[i], calls, n);
        }

        // in operations of CALLS_PER_OP (the root rides along with the first)
        uint256 perOp = CALLS_PER_OP + (needRoot ? 1 : 0);
        uint256 count = n == 0 ? 0 : 1 + (n > perOp ? (n - perOp + CALLS_PER_OP - 1) / CALLS_PER_OP : 0);
        ops = new Op[](count);
        uint256 at = 0;
        for (uint256 k = 0; k < count; k++) {
            uint256 size = k == 0 ? perOp : CALLS_PER_OP;
            if (at + size > n) size = n - at;
            ops[k].targets = new address[](size);
            ops[k].values = new uint256[](size);
            ops[k].payloads = new bytes[](size);
            for (uint256 j = 0; j < size; j++) {
                ops[k].targets[j] = address(pad);
                ops[k].values[j] = calls[at + j].value;
                ops[k].payloads[j] = calls[at + j].data;
            }
            ops[k].salt = keccak256(abi.encode("notus-ledger-migration", root, k));
            at += size;
        }
    }

    /// Plan and schedule, plan and execute: for callers outside this
    /// contract, which cannot take the plan itself back (a tuple that deep
    /// does not decode).
    function scheduleFromFile(TimelockController timelock, Launchpad pad, string memory json, Coin[] memory coins)
        public
        returns (uint256 scheduled)
    {
        return scheduleAll(timelock, plan(pad, json, coins));
    }

    function executeFromFile(TimelockController timelock, Launchpad pad, string memory json, Coin[] memory coins)
        public
        returns (uint256 executed)
    {
        return executeAll(timelock, plan(pad, json, coins));
    }

    /// The plan's shape, for checks: operations, calls per operation, every call's selector in order.
    function planSummary(Launchpad pad, string memory json, Coin[] memory coins)
        public
        view
        returns (uint256 opCount, uint256[] memory callsPerOp, bytes4[] memory selectors)
    {
        Op[] memory ops = plan(pad, json, coins);
        opCount = ops.length;
        callsPerOp = new uint256[](ops.length);
        uint256 total;
        for (uint256 i = 0; i < ops.length; i++) {
            callsPerOp[i] = ops[i].payloads.length;
            total += callsPerOp[i];
        }
        selectors = new bytes4[](total);
        uint256 k;
        for (uint256 i = 0; i < ops.length; i++) {
            for (uint256 j = 0; j < ops[i].payloads.length; j++) {
                selectors[k++] = bytes4(ops[i].payloads[j]);
            }
        }
    }

    /// Schedule every operation not scheduled yet, with the timelock's own delay.
    function scheduleAll(TimelockController timelock, Op[] memory ops) public returns (uint256 scheduled) {
        uint256 delay = timelock.getMinDelay();
        for (uint256 i = 0; i < ops.length; i++) {
            bytes32 id = timelock.hashOperationBatch(ops[i].targets, ops[i].values, ops[i].payloads, bytes32(0), ops[i].salt);
            if (timelock.isOperation(id)) {
                console.log("operation", i, timelock.isOperationDone(id) ? "already executed" : "already scheduled, ready at");
                if (!timelock.isOperationDone(id)) console.log(timelock.getTimestamp(id));
                continue;
            }
            timelock.scheduleBatch(ops[i].targets, ops[i].values, ops[i].payloads, bytes32(0), ops[i].salt, delay);
            scheduled++;
            console.log("scheduled operation", i, "calls:", ops[i].targets.length);
            console.log("  ready at", block.timestamp + delay, "LTC needed:", _sum(ops[i].values));
        }
        if (ops.length == 0) console.log("nothing left to schedule");
    }

    /// Execute every operation that is ready, sending the LTC its coins need.
    function executeAll(TimelockController timelock, Op[] memory ops) public returns (uint256 executed) {
        for (uint256 i = 0; i < ops.length; i++) {
            bytes32 id = timelock.hashOperationBatch(ops[i].targets, ops[i].values, ops[i].payloads, bytes32(0), ops[i].salt);
            if (timelock.isOperationDone(id)) continue;
            if (!timelock.isOperation(id)) {
                console.log("operation", i, "is not scheduled: run MODE=schedule first");
                continue;
            }
            if (!timelock.isOperationReady(id)) {
                console.log("operation", i, "is not ready before", timelock.getTimestamp(id));
                continue;
            }
            timelock.executeBatch{value: _sum(ops[i].values)}(
                ops[i].targets, ops[i].values, ops[i].payloads, bytes32(0), ops[i].salt
            );
            executed++;
            console.log("executed operation", i);
        }
    }

    /// Every coin has its token and no holder left to deliver.
    function allMigrated(Launchpad pad, Coin[] memory coins) public view returns (bool) {
        for (uint256 i = 0; i < coins.length; i++) {
            address token = pad.migratedTicker(keccak256(bytes(coins[i].symbol)));
            if (token == address(0) || pad.migrationPending(token) != 0) return false;
        }
        return true;
    }

    /// The calls one coin still needs: its creation with the first batch of
    /// holders, or the batches of holders not delivered yet.
    function _coinCalls(Launchpad pad, Coin memory c, Call[] memory calls, uint256 n) internal view returns (uint256) {
        require(c.holders.length == c.balances.length, "holders/balances mismatch");
        address token = pad.migratedTicker(keccak256(bytes(c.symbol)));
        if (token == address(0)) {
            uint256 first = c.holders.length < BATCH ? c.holders.length : BATCH;
            (address[] memory h, uint256[] memory b) = _slice(c, 0, first);
            calls[n++] = Call(_value(c), abi.encodeCall(pad.migrateToken, (_ledgerCoin(c), h, b)));
            return n;
        }
        if (pad.migrationPending(token) == 0) return n;
        uint256 from = 0;
        while (from < c.holders.length) {
            (address[] memory h, uint256[] memory b, uint256 next) = _undelivered(pad, token, c, from);
            from = next;
            if (h.length != 0) calls[n++] = Call(0, abi.encodeCall(pad.migrateBalances, (token, h, b)));
        }
        return n;
    }

    /// An upper bound on the calls the coins may need: one to create each, one per batch of holders.
    function _maxCalls(Coin[] memory coins) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < coins.length; i++) {
            total += 1 + (coins[i].holders.length + BATCH - 1) / BATCH;
        }
    }

    /// What a coin arrives with: its reserve (the curve's, or its pool's quote side) and its unspent pots.
    function _value(Coin memory c) internal pure returns (uint256) {
        return c.realQuote + c.burnPot + c.liquidityPot;
    }

    function _ledgerCoin(Coin memory c) internal pure returns (Launchpad.LedgerCoin memory) {
        Launchpad.TokenMetadata memory meta;
        meta.logoURI = c.logo;
        meta.description = "Migrated from Notus on Litecoin";
        return Launchpad.LedgerCoin({
            name: c.name,
            symbol: c.symbol,
            meta: meta,
            creator: c.creator,
            fees: Launchpad.FeeConfig(
                uint16(c.buyTaxBps),
                uint16(c.sellTaxBps),
                uint16(c.creatorBps),
                uint16(c.holdersBps),
                uint16(c.burnBps),
                uint16(c.liquidityBps)
            ),
            virtualQuote: c.virtualQuote,
            sold: c.sold,
            burned: c.burned,
            poolToken: c.poolToken,
            burnPot: c.burnPot,
            liquidityPot: c.liquidityPot
        });
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
    function writeMigrated(Launchpad pad, Coin[] memory coins, string memory file) public {
        string memory tokensKey = "tokens";
        string memory tokensJson = "";
        for (uint256 i = 0; i < coins.length; i++) {
            tokensJson = vm.serializeAddress(tokensKey, coins[i].symbol, pad.migratedTicker(keccak256(bytes(coins[i].symbol))));
        }
        string memory outKey = "out";
        vm.serializeString(outKey, "network", vm.parseJsonString(vm.readFile(file), ".network"));
        vm.serializeUint(outKey, "chainId", block.chainid);
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

    function _sum(uint256[] memory values) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < values.length; i++) {
            total += values[i];
        }
    }

    function _is(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    receive() external payable {}
}
