// The token sync feed: the coins the pad created, in the shape GoPlus's
// "Template Token Sync API" asks of a launchpad (their partnership form,
// 2026-11-04): a page of {chainId, address, launchTime, orderId}, ascending
// by orderId, from the orderId the caller names on. GoPlus reads the feed to
// mark every coin of the pad as a launchpad token in its security API (the
// "Launchpad Token" field), which is what wallets and terminals show as a
// flag. The route is app/api/launchpad/tokens; this file holds what can be
// tested without a node.

/** One coin of the pad, in creation order. `launchTime` is the timestamp of
 *  the block that created it, in milliseconds: the template's example value
 *  has eleven digits and calls the field a Long, a Java timestamp. */
export type SyncItem = { chainId: string; address: `0x${string}`; launchTime: number; orderId: number };

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1_000;

/** The query: `orderId` (the first id wanted, 0 when absent or malformed)
 *  and `limit` (how many at most, DEFAULT_LIMIT when absent, MAX_LIMIT at
 *  most). Anything else is ignored. */
export function parseQuery(p: URLSearchParams): { orderId: number; limit: number } {
  const o = Number(p.get("orderId"));
  const l = Number(p.get("limit"));
  return {
    orderId: Number.isInteger(o) && o >= 0 ? o : 0,
    limit: Number.isInteger(l) && l > 0 ? Math.min(l, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

/** The page: every item whose orderId is `orderId` or more, in order, at
 *  most `limit` of them. The caller's next sync names an id greater than the
 *  largest it got, so a page that ends is a page that was read whole. */
export function page(items: readonly SyncItem[], orderId: number, limit: number): SyncItem[] {
  const out: SyncItem[] = [];
  for (const it of items) {
    if (it.orderId < orderId) continue;
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

/** The feed's items: `tokens` is the pad's own list (`allTokens`, in the
 *  order the pad created them, which only ever grows at the end), so the
 *  orderId is a coin's position in it and never changes; `created` gives
 *  each coin's creation time in seconds, by address in any case. A coin
 *  whose time is not known gets 0, and the route does not answer with such a
 *  list: the caller treats the time as a fact. */
export function itemsOf(chainId: number, tokens: readonly `0x${string}`[], created: ReadonlyMap<string, number>): SyncItem[] {
  return tokens.map((address, orderId) => ({
    chainId: String(chainId),
    address,
    launchTime: (created.get(address.toLowerCase()) ?? 0) * 1000,
    orderId,
  }));
}

/** The body GoPlus expects around a page. */
export function envelope(result: SyncItem[]) {
  return { code: 1, message: "ok", result };
}
