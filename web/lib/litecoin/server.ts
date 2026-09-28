// Server-side reads of the live ledger, for metadata and link previews. The
// same snapshot the /api/ltc-state route proxies for the browser.
import "server-only";
import type { LCoin, LState } from "./client";

export async function readLedger(): Promise<LState | null> {
  const url = process.env.LTC_STATE_URL;
  if (!url) return null;
  try {
    const r = await fetch(url, { next: { revalidate: 30 }, signal: AbortSignal.timeout(6_000) });
    if (!r.ok) return null;
    return (await r.json()) as LState;
  } catch {
    return null;
  }
}

export async function readCoin(ticker: string): Promise<{ coin: LCoin; state: LState } | null> {
  const state = await readLedger();
  const coin = state?.coins.find((c) => c.ticker === ticker.toUpperCase());
  return coin && state ? { coin, state } : null;
}

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://notus-pad.fun";
