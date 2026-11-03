import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMIT, MAX_LIMIT, envelope, itemsOf, page, parseQuery } from "./sync.ts";

const A = "0x00000000000000000000000000000000000000A1" as const;
const B = "0x00000000000000000000000000000000000000b2" as const;
const C = "0x00000000000000000000000000000000000000c3" as const;

test("the query takes orderId and limit, with sane defaults and a cap", () => {
  assert.deepEqual(parseQuery(new URLSearchParams("")), { orderId: 0, limit: DEFAULT_LIMIT });
  assert.deepEqual(parseQuery(new URLSearchParams("orderId=7&limit=5")), { orderId: 7, limit: 5 });
  assert.deepEqual(parseQuery(new URLSearchParams("orderId=-1&limit=0")), { orderId: 0, limit: DEFAULT_LIMIT });
  assert.deepEqual(parseQuery(new URLSearchParams("orderId=abc&limit=99999")), { orderId: 0, limit: MAX_LIMIT });
  assert.deepEqual(parseQuery(new URLSearchParams("orderId=1.5")), { orderId: 0, limit: DEFAULT_LIMIT });
});

test("the items follow the pad's list, ids from zero, times in milliseconds by address in any case", () => {
  const created = new Map<string, number>([
    [A.toLowerCase(), 1_700_000_000],
    [B.toLowerCase(), 1_700_000_100],
  ]);
  assert.deepEqual(itemsOf(8453, [A, B, C], created), [
    { chainId: "8453", address: A, launchTime: 1_700_000_000_000, orderId: 0 },
    { chainId: "8453", address: B, launchTime: 1_700_000_100_000, orderId: 1 },
    { chainId: "8453", address: C, launchTime: 0, orderId: 2 },
  ]);
});

test("a page starts at the orderId asked and stops at the limit", () => {
  const items = itemsOf(8453, [A, B, C], new Map());
  assert.deepEqual(
    page(items, 1, 10).map((x) => x.orderId),
    [1, 2]
  );
  assert.deepEqual(
    page(items, 0, 2).map((x) => x.orderId),
    [0, 1]
  );
  assert.deepEqual(page(items, 3, 10), []);
});

test("the envelope is GoPlus's: code 1, message ok, the page as result", () => {
  assert.deepEqual(envelope([]), { code: 1, message: "ok", result: [] });
});
