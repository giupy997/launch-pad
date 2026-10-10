/** Where the code lives. The repository is public; NEXT_PUBLIC_SOURCE_URL
 *  overrides the address, and the value "off" hides the links (the site then
 *  says the code is published at launch). */
export const SOURCE_URL: string | null =
  process.env.NEXT_PUBLIC_SOURCE_URL === "off" ? null : process.env.NEXT_PUBLIC_SOURCE_URL?.trim() || "https://github.com/giupy997/launch-pad";
/** `git clone` target for the "rebuild this ledger" instructions of the
 *  ledger pages (parked: see parked/README.md at the repository's root). */
export const CLONE_LINE = SOURCE_URL ? `git clone ${SOURCE_URL} && cd ${SOURCE_URL.split("/").pop()?.replace(/\.git$/, "") ?? "notus"}` : null;

/** The site's own address, without a trailing slash: NEXT_PUBLIC_SITE_URL, or
 *  the canonical one. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://notus-pad.fun";

/** Hostnames this site has answered on. A logo the site stored (served at
 *  /i/<id>) carries the absolute URL of the day it was uploaded, and coins
 *  migrated onto the pads kept that URL in their metadata, so any of these
 *  hosts in such a URL means "our own store", whatever the domain is today. */
const configuredHost = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "").host.toLowerCase();
  } catch {
    return null;
  }
})();
export const SITE_HOSTS: readonly string[] = [
  ...new Set(["notus-pad.fun", "www.notus-pad.fun", "notuspad.com", "www.notuspad.com", ...(configuredHost ? [configuredHost] : [])]),
];

/** The id of a logo stored by the site itself (`/i/<id>`, with or without one
 *  of our hostnames in front); null for any other URL. */
export function siteLogoId(url: string): string | null {
  const m = /^(?:https?:\/\/([^/]+))?\/i\/([0-9a-f]{16})$/i.exec(url.trim());
  if (!m) return null;
  if (m[1] && !SITE_HOSTS.includes(m[1].toLowerCase())) return null;
  return m[2].toLowerCase();
}
