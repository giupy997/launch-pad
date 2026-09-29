// The browser wallet's memory of what it just spent, so that a second
// transaction never spends the same coin while an explorer lags behind.
//   node --test --experimental-strip-types lib/litecoin/client.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// a localStorage for Node
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { noteSpend, withPendingSpends, fmtUsd, fmtMcap, marketCapLtc, parseLtc, tickerFromParam } = await import("./client.ts");
const ME = "tltc1qme";

const coin = (n: number, value: bigint, confirmed = true) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, confirmed });

test("coins just spent disappear, the change appears, until the explorer catches up", () => {
  const a = coin(1, 500_000n);
  const b = coin(2, 300_000n);
  const listed = [a, b];
  assert.deepEqual(withPendingSpends(listed, ME), listed, "nothing remembered yet");
  noteSpend({ txid: "ab".repeat(32), inputs: [a], outputs: [{ address: "desk", lit: 100_000n }, { address: null, lit: 0n }, { address: "me", lit: 395_000n }], change: 395_000n }, ME);
  const seen = withPendingSpends(listed, ME);
  assert.deepEqual(seen.map((u) => u.txid.slice(0, 4)), ["0000", "abab"], "a is gone, the change is there");
  assert.deepEqual(seen[1], { txid: "ab".repeat(32), vout: 2, value: 395_000n, confirmed: false });
  // the explorer now lists the change itself (unconfirmed) and no longer lists a
  const change = { txid: "ab".repeat(32), vout: 2, value: 395_000n, confirmed: false };
  assert.deepEqual(withPendingSpends([b, change], ME), [b, change], "no duplicate");
  // spending the change in turn
  noteSpend({ txid: "cd".repeat(32), inputs: [change], outputs: [{ address: "desk", lit: 10_000n }], change: 0n }, ME);
  // another wallet in the same browser knows nothing of this one's spends
  assert.deepEqual(withPendingSpends([b, change], "tltc1qother"), [b, change]);
  assert.deepEqual(withPendingSpends([b, change], ME), [b]);
});

test("market caps read like meme-coin caps: $982, $1.0K, $12.3M — or LTC when the price is unknown", () => {
  assert.equal(fmtUsd(982), "$982");
  assert.equal(fmtUsd(9.5), "$9.50");
  assert.equal(fmtUsd(1_020), "$1.0K");
  assert.equal(fmtUsd(12_345_678), "$12.35M");
  assert.equal(fmtUsd(2.5e9), "$2.50B");
  // 0.0₈982 LTC per coin × 1B coins = 9.82 LTC; at $100 that is $982
  const coin = { vLit: "1019800000", vToken: "103860000000000000" }; // 10.198 LTC / 1.0386B units
  const cap = marketCapLtc(coin);
  assert.ok(cap > 9.8 && cap < 9.9, `${cap}`);
  assert.equal(fmtMcap(cap, 100), "$982");
  assert.equal(fmtMcap(cap, null), "9.82 LTC");
});

test("amounts typed by people parse exactly, and only as plain decimals", () => {
  assert.equal(parseLtc("1"), 100_000_000n);
  assert.equal(parseLtc("0.00000001"), 1n);
  assert.equal(parseLtc(" 12.5 "), 1_250_000_000n);
  assert.equal(parseLtc("0.123456789"), 0n, "more than eight decimals is not an amount");
  assert.equal(parseLtc("1e3"), 0n);
  assert.equal(parseLtc("0x10"), 0n);
  assert.equal(parseLtc("-1"), 0n);
  assert.equal(parseLtc(""), 0n);
});

test("a ticker in a URL is decoded safely", () => {
  assert.equal(tickerFromParam("lester"), "LESTER");
  assert.equal(tickerFromParam("%4C%43AT"), "LCAT");
  assert.equal(tickerFromParam("%"), null, "a broken escape does not throw");
  assert.equal(tickerFromParam("TOO-LONG-1"), null);
  assert.equal(tickerFromParam("x"), null);
});
