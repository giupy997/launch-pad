// node --test --experimental-strip-types lib/litecoin/pin.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_LOGO_BYTES, decodeDataUri, pinLogo } from "./pin.ts";

const png = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64");

test("only small base64 images are accepted", () => {
  assert.equal(decodeDataUri(png).type, "image/png");
  assert.throws(() => decodeDataUri("data:text/html;base64,PGI+"), /not a base64 image/);
  assert.throws(() => decodeDataUri("https://x/y.png"), /not a base64 image/);
  const big = "data:image/webp;base64," + Buffer.alloc(MAX_LOGO_BYTES + 1).toString("base64");
  assert.throws(() => decodeDataUri(big), /KB/);
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
  assert.equal(seen!.file?.size, 7);
  assert.deepEqual(JSON.parse(seen!.options!), { cidVersion: 0 });
  const bad = (async () => new Response("nope", { status: 401 })) as typeof fetch;
  await assert.rejects(pinLogo(png, "X", "jwt", bad), /pinning failed: HTTP 401/);
  const odd = (async () => new Response(JSON.stringify({ IpfsHash: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }))) as typeof fetch;
  await assert.rejects(pinLogo(png, "X", "jwt", odd), /unexpected answer/, "a CIDv1 would not fit the instruction");
});
