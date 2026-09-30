// Garbage collection for the site's own logo store. An upload becomes a
// blob the moment it is made; the coin it was meant for may never be
// deployed. Once a day the store is compared with the ledger: a blob no
// coin (and no instruction waiting for a block) refers to, and older than a
// day, goes. A blob with no date on it (uploaded before dates were kept)
// is first stamped as seen, and goes a day later if still unreferenced.
import { siteLogoId } from "../site.ts";

/** How long an unreferenced upload is kept: a deploy takes minutes, a day is generous. */
export const GRACE_S = 24 * 3600;

export type BlobInfo = { key: string; uploadedAt?: number | null; firstSeen?: number | null };

export type GcPlan = { remove: string[]; stamp: string[]; keep: string[] };

/** The ids of every logo the ledger refers to: each coin's logo, and any
 *  instruction still waiting for a block that names one (a deploy or a
 *  logo change whose coin is not in the ledger yet). */
export function referencedLogoIds(state: { coins: { logo: string }[]; pending?: { memo: string | null }[] } | null | undefined): Set<string> {
  const ids = new Set<string>();
  if (!state) return ids;
  for (const c of state.coins) {
    const id = siteLogoId(c.logo);
    if (id) ids.add(id);
  }
  for (const p of state.pending ?? []) {
    for (const m of (p.memo ?? "").matchAll(/\/i\/([0-9a-f]{16})\b/gi)) ids.add(m[1].toLowerCase());
  }
  return ids;
}

/** What to do with each blob: referenced ones stay; unreferenced ones go
 *  once they have been around for GRACE_S, or get their first date now. */
export function planGc(blobs: BlobInfo[], referenced: Set<string>, now: number): GcPlan {
  const plan: GcPlan = { remove: [], stamp: [], keep: [] };
  for (const b of blobs) {
    if (referenced.has(b.key.toLowerCase())) {
      plan.keep.push(b.key);
      continue;
    }
    const since = b.uploadedAt ?? b.firstSeen ?? null;
    if (since === null) plan.stamp.push(b.key);
    else if (now - since >= GRACE_S) plan.remove.push(b.key);
    else plan.keep.push(b.key);
  }
  return plan;
}

const asTime = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** A blob's dates as its metadata carries them. */
export function blobInfo(key: string, metadata: Record<string, unknown> | undefined | null): BlobInfo {
  return { key, uploadedAt: asTime(metadata?.uploadedAt), firstSeen: asTime(metadata?.firstSeen) };
}
