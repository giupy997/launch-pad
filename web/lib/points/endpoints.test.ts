// The Liteforge endpoints: plain https URLs, in the shape next.config.mjs reads.
//   node --test --experimental-strip-types lib/points/endpoints.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LITEFORGE_EXPLORER, LITEFORGE_RPC } from "./endpoints.ts";
import { POINTS_CHAINS } from "./chains.ts";

test("the endpoints are https URLs, the explorer without a trailing slash", () => {
  assert.equal(new URL(LITEFORGE_RPC).protocol, "https:");
  assert.equal(new URL(LITEFORGE_EXPLORER).protocol, "https:");
  assert.ok(!LITEFORGE_EXPLORER.endsWith("/"));
});

test("the file keeps the one-line shape the Content-Security-Policy is built from", () => {
  const text = readFileSync(new URL("./endpoints.ts", import.meta.url), "utf8");
  const m = /^export const LITEFORGE_RPC = "(https:\/\/[^"]+)";$/m.exec(text);
  assert.ok(m, "next.config.mjs would not find LITEFORGE_RPC");
  assert.equal(m[1], LITEFORGE_RPC);
});

test("the points service reads the chain from the same endpoint", () => {
  assert.deepEqual(POINTS_CHAINS.liteforge.rpcs, [LITEFORGE_RPC]);
  assert.equal(POINTS_CHAINS.liteforge.explorer, LITEFORGE_EXPLORER);
});
