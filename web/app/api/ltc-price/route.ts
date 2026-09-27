// The price of LTC in fiat, for market caps on the Litecoin pages: read
// server-side (litecoinspace's mempool feed, then CoinGecko), remembered
// for five minutes, so visitors' browsers only ever talk to this site.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Price = { usd: number | null; eur: number | null; at: number; source: string | null };
const TTL_MS = 5 * 60_000;
let cached: Price | null = null;

async function read(): Promise<Price> {
  const at = Math.floor(Date.now() / 1000);
  try {
    const r = await fetch("https://litecoinspace.org/api/v1/prices", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const j = (await r.json()) as { USD?: number; EUR?: number };
    if (r.ok && j.USD && j.USD > 0) return { usd: j.USD, eur: j.EUR ?? null, at, source: "litecoinspace" };
  } catch {}
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,eur", { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const j = (await r.json()) as { litecoin?: { usd?: number; eur?: number } };
    if (r.ok && j.litecoin?.usd && j.litecoin.usd > 0) return { usd: j.litecoin.usd, eur: j.litecoin.eur ?? null, at, source: "coingecko" };
  } catch {}
  return { usd: null, eur: null, at, source: null };
}

export async function GET() {
  if (!cached || Date.now() / 1000 - cached.at > TTL_MS / 1000 || cached.usd === null) {
    const fresh = await read();
    if (fresh.usd !== null || !cached) cached = fresh; // keep the last good price through a feed outage
  }
  return NextResponse.json(cached, {
    headers: {
      "cache-control": "public, max-age=120, s-maxage=300, stale-while-revalidate=600",
      "netlify-cdn-cache-control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
