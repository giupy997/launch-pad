// node --test --experimental-strip-types lib/imageType.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageTypeOf } from "./imageType.ts";

test("an image is what its first bytes say, and nothing else is one", () => {
  assert.equal(imageTypeOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])), "image/png");
  assert.equal(imageTypeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(imageTypeOf(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageTypeOf(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(imageTypeOf(Buffer.from("<svg xmlns")), null);
  assert.equal(imageTypeOf(Buffer.from("<html><script>1</script>")), null, "a page is not an image");
  assert.equal(imageTypeOf(new Uint8Array(0)), null);
});
