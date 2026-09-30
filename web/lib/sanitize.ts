/** Creator-supplied metadata is untrusted: only render URLs with safe schemes. */
import { siteLogoId } from "./site.ts";

/** For <a href>: http(s) only. Returns null when unsafe/empty. */
export function safeLink(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  } catch {
    // no scheme: treat as https://<value> if it looks like a host
    if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(u)) return `https://${u}`;
  }
  return null;
}

/** The https URL a logo lives at, for the server to fetch: ipfs:// through a
 *  gateway, http(s) as given; null for anything else. */
export function logoOrigin(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (u.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${u.slice(7)}`;
  try {
    const parsed = new URL(u);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
  } catch {
    /* fall through */
  }
  return null;
}

/** For <img src>: data:image/*, the site's own store (`/i/<id>`), or any
 *  other host through the site's image proxy (`/api/img`), so the page's
 *  policy can name no image host but this one. Null when unsafe or empty. */
export function safeLogo(url: string): string | null {
  const u = url.trim();
  if (!u) return null;
  if (u.startsWith("data:image/")) return u;
  // a logo the site stored: serve it from wherever the site lives today
  const own = siteLogoId(u);
  if (own) return `/i/${own}`;
  const origin = logoOrigin(u);
  if (!origin) return null;
  // http hosts cannot be fetched from a page served over https either way
  return `/api/img?u=${encodeURIComponent(origin.replace(/^http:/, "https:"))}`;
}
