import "server-only";
import type { CoinHoldersView, CoinTradesView } from "./types.ts";

// The site's own routes (app/api/trades, app/api/holders) asking the points
// service for what it read without a time budget: a coin's trades and holders
// on a chain whose public node is too slow for a function to read a coin's
// history (Liteforge: 4 blocks a second, two seconds per 9,000-block
// eth_getLogs, a 10-second function). POINTS_URL names the service, as the
// browser's proxy at /api/points does; POINTS_TOKEN rides along so the
// service's rate limit tells the site apart from a visitor. Null on anything
// but a sound answer for that coin: the route then reads the chain as before.

const BASE = process.env.POINTS_URL?.replace(/\/$/, "") ?? "";
const TOKEN = process.env.POINTS_TOKEN ?? "";
/** what a route gives the service, out of the function's ten seconds */
export const SERVICE_MS = 2_500;

async function get<T extends { chain: string; token: string }>(chainKey: string, token: string, what: "trades" | "holders", ms: number): Promise<T | null> {
  if (!BASE || ms < 300) return null;
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (TOKEN) headers["x-points-token"] = TOKEN;
    const r = await fetch(`${BASE}/${chainKey}/coin/${token.toLowerCase()}/${what}`, { headers, cache: "no-store", signal: AbortSignal.timeout(ms) });
    if (!r.ok) return null;
    const j = (await r.json()) as T;
    // an answer for another coin or chain (a proxy gone wrong) is no answer
    if (j.chain !== chainKey || j.token.toLowerCase() !== token.toLowerCase()) return null;
    return j;
  } catch {
    return null;
  }
}

/** a coin's curve trades from its birth to the service's block, or null */
export const servedTrades = (chainKey: string, token: string, ms = SERVICE_MS) => get<CoinTradesView>(chainKey, token, "trades", ms);
/** who holds a coin by the service's count, or null */
export const servedHolders = (chainKey: string, token: string, ms = SERVICE_MS) => get<CoinHoldersView>(chainKey, token, "holders", ms);
