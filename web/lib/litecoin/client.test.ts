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

const { noteSpend, withPendingSpends } = await import("./client.ts");

const coin = (n: number, value: bigint, confirmed = true) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, confirmed });

test("coins just spent disappear, the change appears, until the explorer catches up", () => {
  const a = coin(1, 500_000n);
  const b = coin(2, 300_000n);
  const listed = [a, b];
  assert.deepEqual(withPendingSpends(listed), listed, "nothing remembered yet");
  noteSpend({ txid: "ab".repeat(32), inputs: [a], outputs: [{ address: "desk", lit: 100_000n }, { address: null, lit: 0n }, { address: "me", lit: 395_000n }], change: 395_000n });
  const seen = withPendingSpends(listed);
  assert.deepEqual(seen.map((u) => u.txid.slice(0, 4)), ["0000", "abab"], "a is gone, the change is there");
  assert.deepEqual(seen[1], { txid: "ab".repeat(32), vout: 2, value: 395_000n, confirmed: false });
  // the explorer now lists the change itself (unconfirmed) and no longer lists a
  const change = { txid: "ab".repeat(32), vout: 2, value: 395_000n, confirmed: false };
  assert.deepEqual(withPendingSpends([b, change]), [b, change], "no duplicate");
  // spending the change in turn
  noteSpend({ txid: "cd".repeat(32), inputs: [change], outputs: [{ address: "desk", lit: 10_000n }], change: 0n });
  assert.deepEqual(withPendingSpends([b, change]), [b]);
});
