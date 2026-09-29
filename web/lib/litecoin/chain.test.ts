// node --test --experimental-strip-types lib/litecoin/chain.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_FALLBACKS, isBlockbook, withFallbacks } from "./chain.ts";

test("withFallbacks: the operator's explorers first, then the public ones not already named", () => {
  assert.equal(withFallbacks(undefined, "main"), PUBLIC_FALLBACKS.main.join(","), "nothing configured: the public ones");
  assert.equal(withFallbacks("", "test"), PUBLIC_FALLBACKS.test.join(","));
  const spec = withFallbacks(" https://ltcbook.nownodes.io/api/v2 , https://litecoinspace.org/api/ ", "main");
  const list = spec.split(",");
  assert.equal(list[0], "https://ltcbook.nownodes.io/api/v2", "the configured one leads");
  assert.equal(list[1], "https://litecoinspace.org/api", "trailing slash trimmed, named once");
  assert.equal(list.filter((s) => s === "https://litecoinspace.org/api").length, 1);
  assert.deepEqual(list.slice(2), PUBLIC_FALLBACKS.main.slice(1), "the rest of the public ones follow");
  assert.ok(list.some((s) => isBlockbook(s)) && list.some((s) => !isBlockbook(s)), "both dialects are in the chain");
});
