"use client";

import { useQuery } from "@tanstack/react-query";
import { BLOCK_SECONDS, GETLOGS_CHUNK, LAUNCHPAD_DEPLOY_BLOCK, RPC_URLS } from "./config";
import { useAppChain, useLaunchpadAddress } from "./hooks";
import {
  latestBlock,
  packTrades,
  scanTrades,
  stampTimestamps,
  unpackTrades,
  type PackedTrade,
  type PoolRef,
  type ScanTarget,
  type Trade,
} from "./trades/scan";

export type { Trade, PoolRef };

// The trades as the pages see them: a coin's history for its feed and chart,
// and the day's volumes for the explore cards. The scanning itself lives in
// lib/trades/scan.ts and runs on the server too (app/api/trades): a browser
// with nothing cached asks the server for the window, one JSON cached at the
// edge for everyone, instead of running dozens of eth_getLogs against a
// public node from a phone. From then on it reads the blocks mined since by
// itself, usually a single getLogs, and keeps the result in localStorage.

const DEFAULT_CHUNK = 9_000n; // a guess for chains without a configured size
const SERVER_TIMEOUT_MS = 9_000;

function targetFor(chain: { id: number; rpcUrls: { default: { http: readonly string[] } } }): ScanTarget {
  return { chainId: chain.id, urls: RPC_URLS[chain.id] ?? chain.rpcUrls.default.http, chunk: GETLOGS_CHUNK[chain.id] ?? DEFAULT_CHUNK };
}

type Served = { trades: Trade[]; first: bigint; last: bigint; truncated: boolean };

/** the server's scan of the window (app/api/trades); null when it does not
 *  answer, in which case the browser scans by itself as it always could */
async function fetchServed(chainId: number, token: `0x${string}` | "all", pools: PoolRef[]): Promise<Served | null> {
  try {
    // lowercase throughout: one entry at the edge however the addresses are written
    const q = new URLSearchParams({ chain: String(chainId), token: token.toLowerCase() });
    if (pools.length) q.set("pools", pools.map((p) => `${p.token}:${p.pair}:${p.tokenIsZero ? 1 : 0}`.toLowerCase()).join(","));
    const r = await fetch(`/api/trades?${q}`, { signal: AbortSignal.timeout(SERVER_TIMEOUT_MS) });
    if (!r.ok) return null;
    const j = (await r.json()) as { chain: number; token: string; first: string; last: string; truncated: boolean; trades: PackedTrade[] };
    // an answer for another coin or chain (a cache gone wrong) is no answer: the browser scans by itself
    if (j.chain !== chainId || j.token.toLowerCase() !== token.toLowerCase()) return null;
    return { trades: unpackTrades(j.trades), first: BigInt(j.first), last: BigInt(j.last), truncated: j.truncated };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistent per-token trade cache: after the first full scan, revisits and
// refreshes only read the blocks mined since (usually a single getLogs)
// instead of re-scanning the whole history — the difference between tens of
// seconds and milliseconds on the token page.

const CACHE_PREFIX = "notus.trades.v3."; // v3: the venue, and a graduated coin's pool swaps
const CACHE_MAX_TRADES = 400; // enough for the chart + feed; keeps quota safe
const VOLUME_MAX_TRADES = 3_000; // a day of the whole pad

type TradeCache = { last: bigint; trades: Trade[]; truncated: boolean };

/** the pools a scan reads, as part of its cache key: a new pool (a graduation)
 *  starts a fresh scan, so its swaps since the window's start are read */
function poolsKey(pools: PoolRef[]): string {
  return pools
    .map((p) => p.pair.toLowerCase())
    .sort()
    .join(",");
}
function cacheKey(chainId: number, token: `0x${string}`, pools: PoolRef[]): string {
  return `${CACHE_PREFIX}${chainId}.${token.toLowerCase()}.${poolsKey(pools) || "curve"}`;
}
function volumesKey(chainId: number, pools: PoolRef[]): string {
  return `${CACHE_PREFIX}${chainId}.all.${poolsKey(pools) || "curve"}`;
}

function loadCache(key: string): TradeCache | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as { last: string; truncated: boolean; trades: PackedTrade[] };
    return { last: BigInt(p.last), truncated: p.truncated, trades: unpackTrades(p.trades) };
  } catch {
    return null;
  }
}

function saveCache(key: string, cache: TradeCache, max = CACHE_MAX_TRADES) {
  const kept = cache.trades.slice(-max);
  const payload = JSON.stringify({
    last: cache.last.toString(),
    truncated: cache.truncated || kept.length < cache.trades.length,
    trades: packTrades(kept),
  });
  try {
    localStorage.setItem(key, payload);
  } catch {
    // quota exceeded: drop every trade cache and try once more
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(key, payload);
    } catch {
      /* private mode or hard quota — run uncached */
    }
  }
}

/** the server's window merged with what the browser had: the server's trades
 *  stand for [first, last], older ones the browser kept stay, and so do newer
 *  ones it read since (the server's copy may be a few seconds behind) */
function mergeServed(cached: TradeCache | null, served: Served): TradeCache {
  if (!cached) return { last: served.last, trades: served.trades, truncated: served.truncated };
  const older = cached.trades.filter((x) => x.block < served.first);
  const newer = cached.trades.filter((x) => x.block > served.last);
  return {
    last: served.last > cached.last ? served.last : cached.last,
    trades: [...older, ...served.trades, ...newer],
    truncated: older.length ? cached.truncated : served.truncated,
  };
}

/** the browser asks the server when it has nothing, or when catching up by
 *  itself would take more than a few getLogs */
function farBehind(t: ScanTarget, cached: TradeCache | null, latest: bigint | null): boolean {
  return !cached || (latest !== null && latest - cached.last > 3n * t.chunk);
}

/** All trades of a token, oldest first, with block timestamps for the most
 *  recent ones: the curve's, and once graduated its pool's swaps too (pass
 *  the pool). The server's scan first when the browser is cold (see above),
 *  then the blocks mined since, read here; a localStorage cache in between.
 *  `enabled` lets a page hold the scan until its own reads are in. */
export function useTrades(token: `0x${string}`, pool: PoolRef | null = null, enabled = true) {
  const chain = useAppChain();
  const pad = useLaunchpadAddress();
  const deployBlock = LAUNCHPAD_DEPLOY_BLOCK[chain.id] ?? 0n;
  const pools = pool ? [pool] : [];

  return useQuery({
    queryKey: ["trades", chain.id, token, pool?.pair ?? null],
    enabled: !!pad && enabled,
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<{ trades: Trade[]; truncated: boolean }> => {
      if (!pad) return { trades: [], truncated: false };
      const t = targetFor(chain);
      const key = cacheKey(chain.id, token, pools);
      const cached = loadCache(key);
      let latest: bigint | null = cached ? await latestBlock(t) : null;

      if (farBehind(t, cached, latest)) {
        const served = await fetchServed(chain.id, token, pools);
        if (served) {
          const merged = mergeServed(cached, served);
          saveCache(key, merged);
          return { trades: merged.trades, truncated: merged.truncated };
        }
      }

      if (latest === null) latest = await latestBlock(t);
      if (cached && latest <= cached.last) return cached;
      const from = cached ? cached.last + 1n : deployBlock;
      const fresh = await scanTrades(t, pad, token, from, latest, pools);
      // nothing new could be read: keep what we have, try again next tick
      if (fresh.last < from) return cached ?? { trades: [], truncated: fresh.truncated };
      const trades = cached ? [...cached.trades, ...fresh.trades] : fresh.trades;
      const truncated = (cached?.truncated ?? false) || fresh.truncated;
      await stampTimestamps(t, trades);

      const result = { trades, truncated };
      saveCache(key, { last: fresh.last, ...result });
      return result;
    },
  });
}

/** The last day's trading of every coin on the pad, summed per token in quote
 *  wei (what buyers paid plus what sellers received), for the explore cards:
 *  the curves' trades, and the pool swaps of the graduated coins in `pools`.
 *  The server's scan of the day when the browser is cold, then only the
 *  blocks mined since (a localStorage cache, like a token's), refreshed every
 *  minute. */
/** A coin's day, from its trades of the last 24 hours. */
export type DaySummary = {
  /** what buyers paid plus what sellers received, in quote wei */
  volume: bigint;
  /** the day's first trade: the price then (quote wei per `tokens` wei) is the day's opening */
  first: { eth: bigint; tokens: bigint; timestamp: number };
  /** the day's last trade */
  last: { eth: bigint; tokens: bigint; timestamp: number; block: bigint };
  trades: number;
};
export type Volumes = { byToken: Record<string, bigint>; days: Record<string, DaySummary>; trades: number; partial: boolean };

export function useVolumes(pools: PoolRef[] = [], ready = true) {
  const chain = useAppChain();
  const pad = useLaunchpadAddress();
  const deployBlock = LAUNCHPAD_DEPLOY_BLOCK[chain.id] ?? 0n;
  const pk = poolsKey(pools);
  return useQuery({
    queryKey: ["volumes-24h", chain.id, pk],
    enabled: !!pad && ready, // once the pools are known, so the day is scanned once
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<Volumes> => {
      const byToken: Record<string, bigint> = {};
      const days: Record<string, DaySummary> = {};
      if (!pad) return { byToken, days, trades: 0, partial: false };
      const t = targetFor(chain);
      const key = volumesKey(chain.id, pools);
      const cached = loadCache(key);
      const blockSeconds = BLOCK_SECONDS[chain.id] ?? 2;
      const perDay = BigInt(Math.round(86_400 / blockSeconds));
      // trades come oldest first: the first seen is the day's opening, the last its close.
      // A trade without its block's time (the browser's own scan reads none, the server
      // stamps the most recent) is placed by its distance from the head, at the chain's pace.
      const sum = (trades: Trade[], partial: boolean, head: bigint): Volumes => {
        const nowSec = Math.floor(Date.now() / 1000);
        const when = (x: Trade) => x.timestamp || Math.max(0, nowSec - Math.round(Number(head > x.block ? head - x.block : 0n) * blockSeconds));
        for (const x of trades) {
          const k = x.token.toLowerCase();
          byToken[k] = (byToken[k] ?? 0n) + x.eth;
          const d = days[k];
          const point = { eth: x.eth, tokens: x.tokens, timestamp: when(x) };
          if (!d) days[k] = { volume: x.eth, first: point, last: { ...point, block: x.block }, trades: 1 };
          else {
            d.volume += x.eth;
            d.last = { ...point, block: x.block };
            d.trades += 1;
          }
        }
        return { byToken, days, trades: trades.length, partial };
      };

      let latest: bigint | null = cached ? await latestBlock(t) : null;
      if (farBehind(t, cached, latest)) {
        const served = await fetchServed(chain.id, "all", pools);
        if (served) {
          // the server's answer is the day itself: what it says is what there is
          saveCache(key, { last: served.last, trades: served.trades, truncated: false }, VOLUME_MAX_TRADES);
          return sum(served.trades, served.truncated, served.last);
        }
      }

      if (latest === null) latest = await latestBlock(t);
      const dayStart = latest > deployBlock + perDay ? latest - perDay : deployBlock;
      let trades = cached?.trades ?? [];
      let last = cached?.last ?? dayStart - 1n;
      let partial = false;
      if (latest > last) {
        const from = last + 1n > dayStart ? last + 1n : dayStart;
        const fresh = await scanTrades(t, pad, null, from, latest, pools);
        if (fresh.last >= from) {
          trades = [...trades, ...fresh.trades];
          last = fresh.last;
        }
        // blocks no node served leave the sums short, not absent
        partial = fresh.last < latest || fresh.truncated;
      }
      trades = trades.filter((x) => x.block >= dayStart);
      saveCache(key, { last, trades, truncated: false }, VOLUME_MAX_TRADES);
      return sum(trades, partial, latest);
    },
  });
}

/** The trades with a time for each: a trade whose block's time was never read
 *  (only the most recent ones get theirs) is placed by its distance in blocks
 *  from the nearest trade that has one, at the chain's pace. A new array where
 *  anything was missing; the trades themselves are not touched. */
export function withEstimatedTimes(trades: Trade[], blockSeconds: number): Trade[] {
  const anchors = trades.filter((x) => x.timestamp > 0);
  if (anchors.length === 0 || anchors.length === trades.length) return trades;
  const oldest = anchors[0];
  const newest = anchors[anchors.length - 1];
  return trades.map((x) => {
    if (x.timestamp > 0) return x;
    const a = x.block < oldest.block ? oldest : newest;
    return { ...x, timestamp: Math.max(1, a.timestamp + Math.round(Number(x.block - a.block) * blockSeconds)) };
  });
}

/** Price per whole token implied by each trade, in quote units (a float, so a
 *  quote with few decimals keeps its fraction). */
export function pricePoints(trades: Trade[], quoteDecimals = 18): number[] {
  return trades
    .filter((t) => t.tokens > 0n)
    .map((t) => Number(t.eth) / 10 ** quoteDecimals / (Number(t.tokens) / 1e18));
}
