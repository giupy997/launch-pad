// The site's own store for coin logos (Netlify Blobs), served at /i/<id>, when
// the host provides one. Netlify does. The name is the one the store was
// created under: renamed, every logo in it would be lost.
import { getStore } from "@netlify/blobs";

export const LOGO_STORE = "ltc-logos";

export function siteStore() {
  try {
    return getStore({ name: LOGO_STORE, consistency: "strong" });
  } catch {
    return null;
  }
}
