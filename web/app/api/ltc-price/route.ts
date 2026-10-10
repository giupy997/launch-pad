// The price of LTC in fiat, for the USD figures of the coins quoted in cbLTC
// and zkLTC (lib/price.ts): read server-side from public feeds, one after
// another until one answers, remembered for five minutes, so visitors'
// browsers only ever talk to this site. The answer says which feed spoke and
// why the others did not, so an outage can be read off /api/ltc-price
// directly.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Price = { usd: number | null; eur: number | null; at: number; source: string | null; tried: string[] };
const TTL_MS = 5 * 60_000;
let cached: Price | null = null;

const HEADERS = { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; notus-pad.fun price reader)" };

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: "no-store", headers: HEADERS, signal: AbortSignal.timeout(6_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Each feed: a name and a reader that gives the USD price (and EUR when it has one). */
const FEEDS: { name: string; read: () => Promise<{ usd: number | null; eur: number | null }> }[] = [
  {
    name: "litecoinspace",
    read: async () => {
      const j = (await getJson("https://litecoinspace.org/api/v1/prices")) as { USD?: unknown; EUR?: unknown };
      return { usd: num(j.USD), eur: num(j.EUR) };
    },
  },
  {
    name: "coinbase",
    read: async () => {
      const j = (await getJson("https://api.coinbase.com/v2/prices/LTC-USD/spot")) as { data?: { amount?: unknown } };
      const usd = num(j.data?.amount);
      let eur: number | null = null;
      try {
        const e = (await getJson("https://api.coinbase.com/v2/prices/LTC-EUR/spot")) as { data?: { amount?: unknown } };
        eur = num(e.data?.amount);
      } catch {}
      return { usd, eur };
    },
  },
  {
    name: "kraken",
    read: async () => {
      const j = (await getJson("https://api.kraken.com/0/public/Ticker?pair=LTCUSD,LTCEUR")) as { result?: Record<string, { c?: unknown[] }> };
      const pairs = Object.entries(j.result ?? {});
      const last = (suffix: string) => num(pairs.find(([k]) => k.endsWith(suffix))?.[1]?.c?.[0]);
      return { usd: last("USD"), eur: last("EUR") };
    },
  },
  {
    name: "binance",
    read: async () => {
      const j = (await getJson("https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT")) as { price?: unknown };
      return { usd: num(j.price), eur: null };
    },
  },
  {
    name: "coingecko",
    read: async () => {
      const j = (await getJson("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,eur")) as { litecoin?: { usd?: unknown; eur?: unknown } };
      return { usd: num(j.litecoin?.usd), eur: num(j.litecoin?.eur) };
    },
  },
  {
    name: "cryptocompare",
    read: async () => {
      const j = (await getJson("https://min-api.cryptocompare.com/data/price?fsym=LTC&tsyms=USD,EUR")) as { USD?: unknown; EUR?: unknown };
      return { usd: num(j.USD), eur: num(j.EUR) };
    },
  },
];

async function read(): Promise<Price> {
  const at = Math.floor(Date.now() / 1000);
  const tried: string[] = [];
  for (const feed of FEEDS) {
    try {
      const { usd, eur } = await feed.read();
      if (usd) return { usd, eur, at, source: feed.name, tried };
      tried.push(`${feed.name}: no price in the answer`);
    } catch (e) {
      tried.push(`${feed.name}: ${(e as Error).message ?? "failed"}`);
    }
  }
  return { usd: null, eur: null, at, source: null, tried };
}

export async function GET() {
  if (!cached || Date.now() / 1000 - cached.at > TTL_MS / 1000 || cached.usd === null) {
    const fresh = await read();
    if (fresh.usd !== null || !cached) cached = fresh; // keep the last good price through a feed outage
  }
  // a price is shared for a while; an outage is never cached, so the next visitor asks again
  const headers = cached.usd !== null
    ? { "cache-control": "public, max-age=120, s-maxage=300, stale-while-revalidate=600", "netlify-cdn-cache-control": "public, s-maxage=300, stale-while-revalidate=600" }
    : { "cache-control": "no-store", "netlify-cdn-cache-control": "no-store" };
  return NextResponse.json(cached, { headers });
}
