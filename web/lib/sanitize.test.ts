// Creator-supplied URLs are rendered only through these helpers.
//   node --test --experimental-strip-types lib/sanitize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeLink, safeLogo } from "./sanitize.ts";
import { siteLogoId } from "./site.ts";

test("a logo the site stored is served from the current origin, whichever hostname the ledger recorded", () => {
  assert.equal(siteLogoId("https://notuspad.com/i/0123456789abcdef"), "0123456789abcdef");
  assert.equal(siteLogoId("https://www.notus-pad.fun/i/0123456789ABCDEF"), "0123456789abcdef");
  assert.equal(siteLogoId("/i/0123456789abcdef"), "0123456789abcdef");
  assert.equal(siteLogoId("https://example.com/i/0123456789abcdef"), null, "someone else's /i/ path is not ours");
  assert.equal(siteLogoId("https://notuspad.com/i/short"), null);
  assert.equal(siteLogoId("https://notuspad.com/logo.png"), null);
  assert.equal(safeLogo("https://notuspad.com/i/0123456789abcdef"), "/i/0123456789abcdef");
  assert.equal(safeLogo("https://notus-pad.fun/i/0123456789abcdef"), "/i/0123456789abcdef");
});

test("every other logo keeps its rules", () => {
  assert.equal(safeLogo("ipfs://QmX"), "https://ipfs.io/ipfs/QmX");
  assert.equal(safeLogo("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(safeLogo("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(safeLogo("javascript:alert(1)"), null);
  assert.equal(safeLogo(""), null);
  assert.equal(safeLink("notus-pad.fun/about"), "https://notus-pad.fun/about");
  assert.equal(safeLink("javascript:alert(1)"), null);
});
