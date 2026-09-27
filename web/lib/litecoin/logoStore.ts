// The site's own store for Litecoin coin logos (Netlify Blobs), when the
// host provides one. Netlify does; elsewhere uploads fall back to IPFS with
// PINATA_JWT, or are off.
import { getStore } from "@netlify/blobs";

export const LOGO_STORE = "ltc-logos";

export function siteStore() {
  try {
    return getStore({ name: LOGO_STORE, consistency: "strong" });
  } catch {
    return null;
  }
}
