// node --test --experimental-strip-types lib/litecoin/logoGc.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRACE_S, blobInfo, planGc, referencedLogoIds } from "./logoGc.ts";

const NOW = 1_800_000_000;

test("referencedLogoIds: every coin's own-store logo, and the ones named by instructions still waiting", () => {
  const ids = referencedLogoIds({
    coins: [
      { logo: "https://notus-pad.fun/i/0123456789abcdef" },
      { logo: "/i/fedcba9876543210" },
      { logo: "ipfs://QmSomething" },
      { logo: "https://evil.example/i/aaaaaaaaaaaaaaaa" },
      { logo: "" },
    ],
    pending: [{ memo: "NOTUS1 deploy CAT Cat 0 https://notus-pad.fun/i/1111111111111111" }, { memo: "NOTUS1 buy CAT 5" }, { memo: null }],
  });
  assert.deepEqual([...ids].sort(), ["0123456789abcdef", "1111111111111111", "fedcba9876543210"]);
  assert.equal(referencedLogoIds(null).size, 0);
});

test("planGc: referenced blobs stay, dated strangers go after a day, undated ones get a date first", () => {
  const referenced = new Set(["0123456789abcdef"]);
  const plan = planGc(
    [
      { key: "0123456789abcdef", uploadedAt: NOW - 10 * GRACE_S }, // old but used
      { key: "aaaaaaaaaaaaaaaa", uploadedAt: NOW - GRACE_S - 1 }, // old and unused
      { key: "bbbbbbbbbbbbbbbb", uploadedAt: NOW - 60 }, // fresh: a deploy may be on its way
      { key: "cccccccccccccccc" }, // from before dates were kept
      { key: "dddddddddddddddd", firstSeen: NOW - GRACE_S }, // stamped a day ago, still unused
      { key: "eeeeeeeeeeeeeeee", firstSeen: NOW - 100 }, // stamped recently
    ],
    referenced,
    NOW
  );
  assert.deepEqual(plan.remove, ["aaaaaaaaaaaaaaaa", "dddddddddddddddd"]);
  assert.deepEqual(plan.stamp, ["cccccccccccccccc"]);
  assert.deepEqual(plan.keep, ["0123456789abcdef", "bbbbbbbbbbbbbbbb", "eeeeeeeeeeeeeeee"]);
});

test("blobInfo: dates only when they are numbers", () => {
  assert.deepEqual(blobInfo("k", { uploadedAt: 5, firstSeen: "x" }), { key: "k", uploadedAt: 5, firstSeen: null });
  assert.deepEqual(blobInfo("k", undefined), { key: "k", uploadedAt: null, firstSeen: null });
});
