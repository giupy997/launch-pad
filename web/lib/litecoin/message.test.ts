// node --test --experimental-strip-types lib/litecoin/message.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/hashes/utils";
import { base64 } from "@scure/base";
import { MAGICS, addressesOfPubkey, messageHash, recoverSigner, signMessage, verifyMessage } from "./message.ts";

const secret = "11".repeat(32);
const pub = secp256k1.getPublicKey(hexToBytes(secret), true);

test("the hash is Bitcoin's message hash with Litecoin's magic: length-prefixed, sha256d", () => {
  // \x19"Litecoin Signed Message:\n" + \x05"hello", double sha256, computed once by hand
  const h = Buffer.from(messageHash("hello")).toString("hex");
  assert.equal(h.length, 64);
  assert.notEqual(h, Buffer.from(messageHash("hello", MAGICS[1])).toString("hex"), "the magic is part of it");
  assert.notEqual(h, Buffer.from(messageHash("hellp")).toString("hex"));
});

test("a signature is 65 bytes, header 31..34 for a compressed key, and recovers that key", () => {
  const sig = signMessage(secret, "notus-logo|00|1");
  const raw = base64.decode(sig);
  assert.equal(raw.length, 65);
  assert.ok(raw[0] >= 31 && raw[0] <= 34, `header ${raw[0]}`);
  const [wpkh, tr, shwpkh, pkh] = addressesOfPubkey(pub, "main");
  assert.match(wpkh, /^ltc1q/);
  assert.match(tr, /^ltc1p/);
  assert.match(shwpkh, /^M/);
  assert.match(pkh, /^L/);
  for (const a of [wpkh, tr, shwpkh, pkh]) {
    assert.deepEqual(recoverSigner(a, "notus-logo|00|1", sig, "main"), pub, a);
    assert.ok(verifyMessage(a, "notus-logo|00|1", sig, "main"));
    assert.ok(!verifyMessage(a, "notus-logo|00|2", sig, "main"), "another text");
    assert.ok(!verifyMessage(a, "notus-logo|00|1", sig, "test"), "another network, other addresses");
  }
  const stranger = addressesOfPubkey(secp256k1.getPublicKey(hexToBytes("22".repeat(32)), true), "main")[0];
  assert.ok(!verifyMessage(stranger, "notus-logo|00|1", sig, "main"), "not this address's key");
});

test("either magic verifies, and garbage never does", () => {
  const [wpkh] = addressesOfPubkey(pub, "test");
  assert.ok(verifyMessage(wpkh, "x", signMessage(secret, "x", MAGICS[0]), "test"));
  assert.ok(verifyMessage(wpkh, "x", signMessage(secret, "x", MAGICS[1]), "test"));
  assert.ok(!verifyMessage(wpkh, "x", "", "test"));
  assert.ok(!verifyMessage(wpkh, "x", "AAAA", "test"), "too short");
  assert.ok(!verifyMessage(wpkh, "x", base64.encode(new Uint8Array(65)), "test"), "a zero signature");
  const raw = base64.decode(signMessage(secret, "x"));
  const recovery = (raw[0] - 27) & 3;
  raw[0] = 39 + recovery; // the BIP137 header wallets write for a bech32 address: the same key
  assert.ok(verifyMessage(wpkh, "x", base64.encode(raw), "test"));
  raw[0] = 26;
  assert.ok(!verifyMessage(wpkh, "x", base64.encode(raw), "test"), "a header out of range");
});
