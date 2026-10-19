import { unpackTrades, type PackedTrade, type Scan } from "./scan.ts";

// A coin's history as the points service has it, joined with what the chain
// says since. Pure: app/api/trades calls it, its test runs it on made-up
// answers. No React, no config.

/** what the service answered: the curve's trades from the coin's birth up to
 *  `last` (lib/points/types.ts, CoinTradesView), and the block the coin
 *  graduated at, if it did */
export type ServedHistory = { trades: PackedTrade[]; last: bigint; graduated: bigint | null };

/** The service's trades, then the fresh scan's from the block after the
 *  service's (pool swaps included: a graduated coin's pool is not the pad's
 *  event, the chain is the only place to read it). The answer starts at the
 *  deploy block, as a scan over the whole history would: the service read
 *  from there. Truncated when something is known to be missing: the pool's
 *  swaps between the graduation and the service's block, which no one read,
 *  or a fresh scan that did not reach the service's block (a gap). */
export function joinHistory(served: ServedHistory, fresh: Scan | null, hasPool: boolean, deployBlock: bigint): Scan {
  const base = unpackTrades(served.trades).filter((x) => x.block <= served.last);
  const reached = fresh !== null && fresh.last > served.last;
  const gap = reached && fresh.first > served.last + 1n;
  const since = reached && !gap ? fresh.trades.filter((x) => x.block > served.last) : [];
  const poolMissing = hasPool && served.graduated !== null && served.graduated <= served.last;
  return {
    trades: [...base, ...since],
    truncated: poolMissing || gap || (reached && fresh.truncated),
    first: deployBlock,
    last: reached && !gap ? fresh.last : served.last,
  };
}
