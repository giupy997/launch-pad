// Fetching a picture somebody else chose, from the server: only over https,
// only from a public host that resolves to public addresses, never following
// a redirect, never more than a set number of bytes, only a raster image. The
// connection goes to the very address that was checked: a host whose DNS
// answers differently the second time (a public address for the check, a
// private one for the fetch) cannot steer the request inward.
import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
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

/** The public address a public https URL's host resolves to (the first of
 *  them, every one checked), or null: an address, a local name, a host that
 *  resolves to anything private, or one that does not resolve at all. */
export async function publicAddressOf(url: string): Promise<{ url: URL; address: string; family: 4 | 6 } | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || isIP(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".arpa") || host.endsWith(".localhost")) return null;
  try {
    const addrs = await lookup(host, { all: true });
    if (!addrs.length || !addrs.every((a) => isPublicAddress(a.address))) return null;
    return { url: u, address: addrs[0].address, family: addrs[0].family === 6 ? 6 : 4 };
  } catch {
    return null;
  }
}

/** True when the URL names a public https host (not an address, not a local name). */
export async function isPublicHttpsUrl(url: string): Promise<boolean> {
  return (await publicAddressOf(url)) !== null;
}

/** The image at a public https URL, or null: wrong type, too big, slow,
 *  redirecting or unreachable all yield null. The request is made to the
 *  address the check saw (the host's name still goes in the TLS handshake
 *  and the Host header), so no second resolution can send it elsewhere. */
export async function fetchPublicImage(url: string, maxBytes: number, timeoutMs: number): Promise<{ type: string; bytes: Uint8Array } | null> {
  const target = await publicAddressOf(url);
  if (!target) return null;
  const { url: u, address, family } = target;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: { type: string; bytes: Uint8Array } | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = httpsRequest(
      {
        hostname: u.hostname,
        servername: u.hostname,
        port: u.port ? Number(u.port) : 443,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { accept: "image/*", host: u.host },
        timeout: timeoutMs,
        // the address checked above, whatever the name resolves to now
        lookup: (_host, opts, cb) => {
          const o = opts as { all?: boolean };
          if (o?.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
          else cb(null, address, family);
        },
      },
      (res) => {
        const type = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        const declared = Number(res.headers["content-length"] ?? 0);
        // a redirect is not followed: it would be a new host, unchecked
        if (res.statusCode !== 200 || !IMAGE_TYPES.has(type) || declared > maxBytes) {
          res.destroy();
          return finish(null);
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.byteLength;
          if (total > maxBytes) {
            res.destroy();
            return finish(null);
          }
          chunks.push(c);
        });
        res.on("end", () => finish(total > 0 ? { type, bytes: new Uint8Array(Buffer.concat(chunks)) } : null));
        res.on("error", () => finish(null));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => finish(null));
    req.end();
  });
}
