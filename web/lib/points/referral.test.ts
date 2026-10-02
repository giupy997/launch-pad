// Accepting an invite: the invitee's own signature over the exact message,
// and nothing else, binds a wallet.
//   node --test --experimental-strip-types web/lib/points/referral.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { referralMessage, verifyReferral } from "./referral.ts";

const invitee = privateKeyToAccount(`0x${"11".repeat(32)}`);
const inviter = privateKeyToAccount(`0x${"22".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"33".repeat(32)}`);

test("the message names the inviter, the chain and the season, lowercase", () => {
  assert.equal(referralMessage(inviter.address, "liteforge", 0), `Notus referral\nI was invited by ${inviter.address.toLowerCase()}\nliteforge · Season 0`);
});

test("the invitee's signature verifies; anyone else's does not", async () => {
  const message = referralMessage(inviter.address, "liteforge", 0);
  const good = await invitee.signMessage({ message });
  assert.deepEqual(await verifyReferral({ invitee: invitee.address, inviter: inviter.address, signature: good, chainKey: "liteforge", seasonNumber: 0 }), { ok: true });
  // the inviter's own signature cannot bind the invitee
  const byInviter = await inviter.signMessage({ message });
  assert.equal((await verifyReferral({ invitee: invitee.address, inviter: inviter.address, signature: byInviter, chainKey: "liteforge", seasonNumber: 0 })).ok, false);
  // a stranger's
  const byStranger = await stranger.signMessage({ message });
  assert.equal((await verifyReferral({ invitee: invitee.address, inviter: inviter.address, signature: byStranger, chainKey: "liteforge", seasonNumber: 0 })).ok, false);
  // the right signer over another season, chain or inviter
  assert.equal((await verifyReferral({ invitee: invitee.address, inviter: inviter.address, signature: good, chainKey: "liteforge", seasonNumber: 1 })).ok, false);
  assert.equal((await verifyReferral({ invitee: invitee.address, inviter: inviter.address, signature: good, chainKey: "base", seasonNumber: 0 })).ok, false);
  assert.equal((await verifyReferral({ invitee: invitee.address, inviter: stranger.address, signature: good, chainKey: "liteforge", seasonNumber: 0 })).ok, false);
});

test("a wallet cannot invite itself, and junk is refused before any cryptography", async () => {
  const message = referralMessage(invitee.address, "liteforge", 0);
  const self = await invitee.signMessage({ message });
  assert.deepEqual(await verifyReferral({ invitee: invitee.address, inviter: invitee.address, signature: self, chainKey: "liteforge", seasonNumber: 0 }), {
    ok: false,
    reason: "a wallet cannot invite itself",
  });
  assert.equal((await verifyReferral({ invitee: "0x123", inviter: inviter.address, signature: self, chainKey: "liteforge", seasonNumber: 0 })).ok, false);
  assert.equal((await verifyReferral({ invitee: invitee.address, inviter: inviter.address, signature: "0xabc", chainKey: "liteforge", seasonNumber: 0 })).ok, false);
});
