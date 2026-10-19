// The join of the points service's history with the chain's recent blocks
// (lib/trades/history.ts), on made-up answers: a coin on its curve, new
// trades since the service's block, a scan that left a gap, a graduated
// coin whose pool swaps nobody read.
//   node --test --experimental-strip-types lib/trades/history.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinHistory } from "./history.ts";
import type { PackedTrade, Scan, Trade } from "./scan.ts";

const COIN = "0x00000000000000000000000000000000000c0001" as const;
const A = "0x00000000000000000000000000000000000000a1" as const;
const packed = (type: "buy" | "sell", block: number, eth: string): PackedTrade => [type, A, eth, "1000", String(block), `0x${block.toString(16).padStart(64, "0")}`, 0, COIN, "curve", ""];
const fresh = (type: "buy" | "sell", block: number, venue: "curve" | "pool" = "curve"): Trade => ({
  type,
  token: COIN,
  trader: A,
  eth: 1n,
  tokens: 1000n,
  block: BigInt(block),
  tx: `0x${block.toString(16).padStart(64, "0")}`,
  timestamp: 0,
  venue,
});
const DEPLOY = 1_000n;

test("the service alone: its trades, from the deploy block to its own block", () => {
  const out = joinHistory({ trades: [packed("buy", 1_100, "5"), packed("sell", 1_200, "2")], last: 1_500n, graduated: null }, null, false, DEPLOY);
  assert.equal(out.trades.length, 2);
  assert.equal(out.trades[0].type, "buy");
  assert.equal(out.trades[0].eth, 5n);
  assert.equal(out.first, DEPLOY);
  assert.equal(out.last, 1_500n);
  assert.equal(out.truncated, false);
});

test("the chain's trades since the service's block follow; what the scan repeats of the service's is dropped", () => {
  const scan: Scan = { trades: [fresh("buy", 1_500), fresh("buy", 1_501), fresh("sell", 1_600)], truncated: false, first: 1_501n, last: 1_700n };
  const out = joinHistory({ trades: [packed("buy", 1_100, "5")], last: 1_500n, graduated: null }, scan, false, DEPLOY);
  assert.deepEqual(
    out.trades.map((x) => [x.type, Number(x.block)]),
    [
      ["buy", 1_100],
      ["buy", 1_501],
      ["sell", 1_600],
    ]
  );
  assert.equal(out.last, 1_700n);
  assert.equal(out.truncated, false);
});

test("a scan that did not reach the service's block leaves a gap: nothing of it is taken, and the answer says so", () => {
  const scan: Scan = { trades: [fresh("buy", 1_650)], truncated: true, first: 1_600n, last: 1_700n };
  const out = joinHistory({ trades: [packed("buy", 1_100, "5")], last: 1_500n, graduated: null }, scan, false, DEPLOY);
  assert.equal(out.trades.length, 1);
  assert.equal(out.last, 1_500n);
  assert.equal(out.truncated, true);
});

test("a graduated coin's pool swaps before the service's block were read by nobody: truncated; a graduation inside the scan is whole", () => {
  const scan: Scan = { trades: [fresh("buy", 1_550, "pool")], truncated: false, first: 1_501n, last: 1_700n };
  const before = joinHistory({ trades: [packed("buy", 1_100, "5")], last: 1_500n, graduated: 1_400n }, scan, true, DEPLOY);
  assert.equal(before.truncated, true);
  assert.equal(before.trades.length, 2);
  const inside = joinHistory({ trades: [packed("buy", 1_100, "5")], last: 1_500n, graduated: 1_520n }, scan, true, DEPLOY);
  assert.equal(inside.truncated, false);
  // no pool named: nothing of a pool is missing, whenever the coin graduated
  assert.equal(joinHistory({ trades: [], last: 1_500n, graduated: 1_400n }, null, false, DEPLOY).truncated, false);
});
