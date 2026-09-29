// node --test --experimental-strip-types lib/litecoin/pin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LOGO_BYTES, decodeDataUri, imageTypeOf, pinLogo } from "./pin.ts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/hashes/utils";
import { LOGO_AUTH_WINDOW_S, logoMessageFor, signLogo, verifyLogo } from "./logoAuth.ts";
import { addressesOfPubkey, signMessage } from "./message.ts";
import { walletFromSecret } from "./tx.ts";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = "data:image/png;base64," + PNG_BYTES.toString("base64");

test("only small base64 images are accepted, and only when the bytes are what the label says", () => {
  assert.equal(decodeDataUri(png).type, "image/png");
  assert.throws(() => decodeDataUri("data:text/html;base64,PGI+"), /not a base64 image/);
  assert.throws(() => decodeDataUri("https://x/y.png"), /not a base64 image/);
  const big = "data:image/webp;base64," + Buffer.alloc(MAX_LOGO_BYTES + 1).toString("base64");
  assert.throws(() => decodeDataUri(big), /KB/);
  // an HTML page (or anything else) labelled as an image is refused by its bytes
  assert.throws(() => decodeDataUri("data:image/png;base64," + Buffer.from("<html><script>1</script>").toString("base64")), /not the image type/);
  assert.throws(() => decodeDataUri("data:image/webp;base64," + PNG_BYTES.toString("base64")), /not the image type/, "a PNG is not a WebP");
  assert.equal(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageTypeOf(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageTypeOf(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(imageTypeOf(Buffer.from("<svg xmlns")), null);
});

test("an upload is signed by the wallet key over the very bytes, and only for a while", () => {
  const secret = "11".repeat(32);
  const me = walletFromSecret(secret, "test").address;
  const auth = signLogo(secret, PNG_BYTES, 1_800_000_000);
  assert.match((auth as { pubkey: string }).pubkey, /^0[23][0-9a-f]{64}$/);
  assert.equal(verifyLogo(auth, PNG_BYTES, "test", 1_800_000_000 + 60), me, "the wallet's address vouches");
  assert.equal(verifyLogo(auth, Buffer.from([...PNG_BYTES, 9]), "test", 1_800_000_000 + 60), null, "other bytes, other signature");
  assert.equal(verifyLogo(auth, PNG_BYTES, "test", 1_800_000_000 + LOGO_AUTH_WINDOW_S + 1), null, "too old");
  assert.equal(verifyLogo({ ...auth, pubkey: "02" + "ab".repeat(32) }, PNG_BYTES, "test", 1_800_000_000), null, "another key did not sign this");
  assert.equal(verifyLogo(undefined, PNG_BYTES, "test"), null);
  assert.equal(verifyLogo({ ...auth, signature: "zz" }, PNG_BYTES, "test", 1_800_000_000), null);
  assert.notEqual(verifyLogo(auth, PNG_BYTES, "main", 1_800_000_000), me, "the same key has another address on mainnet");
});

test("an extension wallet signs the same text the Litecoin way, for any of its address kinds", () => {
  const secret = "22".repeat(32);
  const pub = secp256k1.getPublicKey(hexToBytes(secret), true);
  const { ts, text } = logoMessageFor(PNG_BYTES, 1_800_000_000);
  for (const address of addressesOfPubkey(pub, "test")) {
    const auth = { ts, address, signedMessage: signMessage(secret, text) };
    assert.equal(verifyLogo(auth, PNG_BYTES, "test", ts + 30), address, `${address.slice(0, 6)}… vouches`);
    assert.equal(verifyLogo(auth, Buffer.from([...PNG_BYTES, 9]), "test", ts + 30), null, "other bytes");
    assert.equal(verifyLogo({ ...auth, ts: ts + 1 }, PNG_BYTES, "test", ts + 30), null, "other time, other text");
  }
  const [wpkh, tr] = addressesOfPubkey(pub, "test");
  const other = walletFromSecret("33".repeat(32), "test").address;
  assert.equal(verifyLogo({ ts, address: other, signedMessage: signMessage(secret, text) }, PNG_BYTES, "test", ts), null, "not that address's key");
  assert.equal(verifyLogo({ ts, address: tr, signedMessage: signMessage(secret, text, "Bitcoin Signed Message:\n") }, PNG_BYTES, "test", ts), tr, "Bitcoin's magic is accepted too");
  assert.equal(verifyLogo({ ts, address: wpkh, signedMessage: "not base64!" }, PNG_BYTES, "test", ts), null);
  assert.equal(verifyLogo({ ts, address: "ltc1qbad", signedMessage: signMessage(secret, text) }, PNG_BYTES, "test", ts), null, "not an address of this network");
});

test("pins through Pinata as a CIDv0 and hands back the ipfs:// URI", async () => {
  let seen: { url: string; auth: string | undefined; file: File | null; options: string | null } | null = null;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    seen = { url: String(url), auth: (init?.headers as Record<string, string>).authorization, file: form.get("file") as File, options: form.get("pinataOptions") as string };
    return new Response(JSON.stringify({ IpfsHash: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", PinSize: 7 }));
  }) as typeof fetch;
  const uri = await pinLogo(png, "LESTER", "jwt-1", fetchImpl);
  assert.equal(uri, "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
  assert.ok(seen);
  assert.equal(seen!.url, "https://api.pinata.cloud/pinning/pinFileToIPFS");
  assert.equal(seen!.auth, "Bearer jwt-1");
  assert.equal(seen!.file?.size, PNG_BYTES.length);
  assert.deepEqual(JSON.parse(seen!.options!), { cidVersion: 0 });
  const bad = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(pinLogo(png, "X", "jwt", bad), /pinning failed: HTTP 401/);
  const odd = (async () => new Response(JSON.stringify({ IpfsHash: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }))) as typeof fetch;
  await assert.rejects(pinLogo(png, "X", "jwt", odd), /unexpected answer/, "a CIDv1 would not fit the instruction");
});
