// Fetching a picture somebody else chose, from the server: only over https,
// only from a public host that resolves to public addresses, never following
// a redirect, never more than a set number of bytes, only a raster image.
import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Loopback, private, link-local, multicast, unspecified: nothing a public picture lives on. */
export function isPublicAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  const h = ip.toLowerCase();
  if (h === "::" || h === "::1") return false;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return false; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return false; // fe80::/10 link local
  if (/^ff[0-9a-f]{2}:/.test(h)) return false; // multicast
  return true;
}

/** True when the URL names a public https host (not an address, not a local name). */
export async function isPublicHttpsUrl(url: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || isIP(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".arpa") || host.endsWith(".localhost")) return false;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => isPublicAddress(a.address));
  } catch {
    return false;
  }
}

/** The image at a public https URL, or null: wrong type, too big, slow, redirecting or unreachable all yield null. */
export async function fetchPublicImage(url: string, maxBytes: number, timeoutMs: number): Promise<{ type: string; bytes: Uint8Array } | null> {
  if (!(await isPublicHttpsUrl(url))) return null;
  try {
    const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "image/*" } });
    const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!r.ok || !IMAGE_TYPES.has(type) || !r.body) return null;
    const declared = Number(r.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return null;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return total > 0 ? { type, bytes } : null;
  } catch {
    return null;
  }
}
