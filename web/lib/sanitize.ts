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

/** What a creator types for a social link, stored as a full URL: a handle
 *  (with or without @) becomes https://<base>/<handle>, a URL stays as
 *  typed, an empty field stays empty. The create form and the creator's
 *  panel store links the same way. */
export function prefixed(value: string, base: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `https://${base}/${v.replace(/^@/, "")}`;
}

/** The handle a stored link shows in a field prefixed with <base>/: the
 *  part after https://<base>/ when the link is on that host, else the whole
 *  link, which prefixed() then keeps as typed. */
export function handleOf(url: string, base: string): string {
  const m = url.trim().match(new RegExp(`^https?://(www\\.)?${base.replace(/\./g, "\\.")}/(.+)$`, "i"));
  return m ? m[2] : url.trim();
}
