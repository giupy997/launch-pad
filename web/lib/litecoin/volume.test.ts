// Recent volume: what the desk computes for the snapshot, and what the site
// sums itself from the trades an older desk publishes.
//   node --test --experimental-strip-types lib/litecoin/volume.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { volumeWindows, type Trade } from "./ledger.ts";

// a localStorage for Node, before the client module is loaded
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;
const { coinVolume, fmtVolume } = await import("./client.ts");

const NOW = 1_800_000_000;
const trade = (ticker: string, type: "buy" | "sell", lit: bigint, fee: bigint, ageS: number): Trade => ({
  ticker, type, holder: "tltc1qholder", lit, tokens: 1n, fee, height: 1, time: NOW - ageS, txid: "00".repeat(32),
});

test("volumeWindows: buys count what went in, sells what came out plus the fee, by window", () => {
  const trades = [
    trade("CAT", "buy", 100n, 1n, 60), // last hour
    trade("CAT", "sell", 50n, 2n, 5 * 3600), // last eight hours: 52 gross
    trade("CAT", "buy", 1_000n, 10n, 20 * 3600), // last day
    trade("CAT", "buy", 5_000n, 50n, 30 * 3600), // older: not counted
    trade("DOG", "buy", 7n, 0n, 10), // another coin
  ];
  const v = volumeWindows(trades, NOW);
  assert.deepEqual(v.get("CAT"), { h1: 100n, h8: 152n, h24: 1_152n });
  assert.deepEqual(v.get("DOG"), { h1: 7n, h8: 7n, h24: 7n });
  assert.equal(v.get("BIRD"), undefined, "a coin without recent trades has no entry");
  assert.deepEqual(volumeWindows(trades, NOW + 3 * 24 * 3600).size, 0, "three days on, nothing is recent");
});

test("coinVolume: the desk's numbers when it sent them, else the site's own sum from the trades", () => {
  const fromDesk = coinVolume({ ticker: "CAT", volume: { h1: "5", h8: "6", h24: "7" } }, { trades: [] }, NOW);
  assert.deepEqual(fromDesk, { h1: 5n, h8: 6n, h24: 7n });
  const trades = [
    { ticker: "CAT", type: "buy" as const, holder: "x", lit: "100", tokens: "1", fee: "1", height: 1, time: NOW - 60, txid: "a" },
    { ticker: "CAT", type: "sell" as const, holder: "x", lit: "50", tokens: "1", fee: "2", height: 1, time: NOW - 5 * 3600, txid: "b" },
    { ticker: "DOG", type: "buy" as const, holder: "x", lit: "9", tokens: "1", fee: "0", height: 1, time: NOW - 60, txid: "c" },
  ];
  assert.deepEqual(coinVolume({ ticker: "CAT" }, { trades }, NOW), { h1: 100n, h8: 152n, h24: 152n });
  assert.deepEqual(coinVolume({ ticker: "BIRD" }, { trades }, NOW), { h1: 0n, h8: 0n, h24: 0n });
  assert.deepEqual(coinVolume({ ticker: "CAT" }, null, NOW), { h1: 0n, h8: 0n, h24: 0n }, "no state, nothing to sum");
});

test("fmtVolume: dollars when the price is known, LTC otherwise, a dash for nothing", () => {
  assert.equal(fmtVolume(0n, 90), "—");
  assert.equal(fmtVolume(100_000_000n, 90), "$90");
  assert.equal(fmtVolume(100_000_000n, null), "1.00 LTC");
  assert.equal(fmtVolume(2_000_000_000n, 90), "$1.8K");
});
