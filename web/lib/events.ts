"use client";

import { useQuery } from "@tanstack/react-query";
import {
  createPublicClient,
  decodeEventLog,
  encodeEventTopics,
  http,
  numberToHex,
  parseAbiItem,
  type Chain,
  type PublicClient,
  type RpcLog,
} from "viem";
import { LAUNCHPAD_DEPLOY_BLOCK } from "./config";
import { useAppChain, useLaunchpadAddress } from "./hooks";

export type Trade = {
  type: "buy" | "sell";
  trader: `0x${string}`;
  eth: bigint;
  tokens: bigint;
  block: bigint;
  tx: `0x${string}`;
  timestamp: number; // unix seconds, 0 if unknown
};

const boughtEvent = parseAbiItem(
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee)"
);
const soldEvent = parseAbiItem(
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee)"
);
const tradeAbi = [boughtEvent, soldEvent] as const;
const topicBought = encodeEventTopics({ abi: [boughtEvent] })[0];
const topicSold = encodeEventTopics({ abi: [soldEvent] })[0];

// Log scans get their own NON-batched clients: some public RPCs (GIWA) queue
// JSON-RPC batch requests containing eth_getLogs for ~10s each, while the
// same calls sent individually answer in well under 2s.
const scanClients = new Map<number, PublicClient>();
function scanClient(chain: Chain): PublicClient {
  let c = scanClients.get(chain.id);
  if (!c) {
    // generous timeout: some ranges take >10s when the RPC throttles
    c = createPublicClient({ chain, transport: http(undefined, { timeout: 25_000, retryCount: 2 }) });
    scanClients.set(chain.id, c);
  }
  return c;
}

// chains whose RPC rejected an unbounded getLogs range (GIWA caps at 100k
// blocks; Robinhood answers the full history in one call) — probed once.
const needsChunking = new Set<number>();

/** eth_getLogs covering BOTH trade events (topic0 OR-filter), server-filtered
 *  by token. Tries the whole range in ONE request first; falls back to
 *  concurrent chunks only on RPCs that cap the block range. */
async function scanTrades(
  client: PublicClient,
  chainId: number,
  pad: `0x${string}`,
  token: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint
): Promise<{ trades: Trade[]; truncated: boolean }> {
  const CHUNK = 90_000n; // stays under the common 100k range cap
  // Only range-capped RPCs (GIWA) reach the chunked path, and they throttle
  // sustained bursts hard — keep the first scan to ~1M recent blocks (weeks
  // of history) and flag the rest as truncated; the incremental cache keeps
  // everything from there on.
  const MAX_CHUNKS = 12;
  const CONCURRENCY = 6; // higher trips public-RPC rate limits
  const topicToken = `0x${token.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
  const topics = [[topicBought, topicSold], topicToken];

  if (!needsChunking.has(chainId)) {
    try {
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [
          { address: pad, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock), topics },
        ],
      })) as RpcLog[];
      return { trades: decodeTrades(logs), truncated: false };
    } catch {
      needsChunking.add(chainId); // range-capped (or hiccup) — chunk from now on
    }
  }

  // most recent ranges first, so trades near "now" survive the chunk cap
  const ranges: { lo: bigint; hi: bigint }[] = [];
  let hi = toBlock;
  while (hi >= fromBlock && ranges.length < MAX_CHUNKS) {
    const lo = hi - CHUNK + 1n > fromBlock ? hi - CHUNK + 1n : fromBlock;
    ranges.push({ lo, hi });
    hi = lo - 1n;
  }

  const perChunk: RpcLog[][] = new Array(ranges.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, async () => {
      while (next < ranges.length) {
        const i = next++;
        const r = ranges[i];
        const params = {
          address: pad,
          fromBlock: numberToHex(r.lo),
          toBlock: numberToHex(r.hi),
          topics,
        } as const;
        // retry each chunk on its own: one hiccup must not restart the scan
        for (let attempt = 0; ; attempt++) {
          try {
            perChunk[i] = (await client.request({ method: "eth_getLogs", params: [params] })) as RpcLog[];
            break;
          } catch (e) {
            if (attempt >= 2) throw e;
          }
        }
      }
    })
  );

  return { trades: decodeTrades(perChunk.flat()), truncated: hi >= fromBlock };
}

function decodeTrades(logs: RpcLog[]): Trade[] {
  return logs
    .map((l) => {
      const d = decodeEventLog({ abi: tradeAbi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
      const base = { block: BigInt(l.blockNumber ?? "0x0"), tx: l.transactionHash as `0x${string}`, timestamp: 0 };
      if (d.eventName === "Bought") {
        const a = d.args as { buyer: `0x${string}`; ethIn: bigint; tokensOut: bigint };
        return { type: "buy" as const, trader: a.buyer, eth: a.ethIn, tokens: a.tokensOut, ...base };
      }
      const a = d.args as { seller: `0x${string}`; tokensIn: bigint; ethOut: bigint };
      return { type: "sell" as const, trader: a.seller, eth: a.ethOut, tokens: a.tokensIn, ...base };
    })
    .sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Persistent per-token trade cache: after the first full scan, revisits and
// refreshes only read the blocks mined since (usually a single getLogs)
// instead of re-scanning the whole history — the difference between tens of
// seconds and milliseconds on the token page.

const CACHE_PREFIX = "notus.trades.v1.";
const CACHE_MAX_TRADES = 400; // enough for the chart + feed; keeps quota safe

type TradeCache = { last: bigint; trades: Trade[]; truncated: boolean };

function cacheKey(chainId: number, token: `0x${string}`): string {
  return `${CACHE_PREFIX}${chainId}.${token.toLowerCase()}`;
}

function loadCache(key: string): TradeCache | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const p = JSON.parse(raw) as {
      last: string;
      truncated: boolean;
      trades: [string, `0x${string}`, string, string, string, `0x${string}`, number][];
    };
    return {
      last: BigInt(p.last),
      truncated: p.truncated,
      trades: p.trades.map(([type, trader, eth, tokens, block, tx, timestamp]) => ({
        type: type as "buy" | "sell",
        trader,
        eth: BigInt(eth),
        tokens: BigInt(tokens),
        block: BigInt(block),
        tx,
        timestamp,
      })),
    };
  } catch {
    return null;
  }
}

function saveCache(key: string, cache: TradeCache) {
  const kept = cache.trades.slice(-CACHE_MAX_TRADES);
  const payload = JSON.stringify({
    last: cache.last.toString(),
    truncated: cache.truncated || kept.length < cache.trades.length,
    trades: kept.map((t) => [
      t.type,
      t.trader,
      t.eth.toString(),
      t.tokens.toString(),
      t.block.toString(),
      t.tx,
      t.timestamp,
    ]),
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

/** All curve trades for a token, oldest first, with block timestamps for the
 *  most recent ones. No backend: reads straight from the chain, with a
 *  localStorage cache so only new blocks are scanned after the first visit. */
export function useTrades(token: `0x${string}`) {
  const chain = useAppChain();
  const pad = useLaunchpadAddress();
  const deployBlock = LAUNCHPAD_DEPLOY_BLOCK[chain.id] ?? 0n;

  return useQuery({
    queryKey: ["trades", chain.id, token],
    enabled: !!pad,
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<{ trades: Trade[]; truncated: boolean }> => {
      if (!pad) return { trades: [], truncated: false };
      const client = scanClient(chain);
      const key = cacheKey(chain.id, token);
      const cached = loadCache(key);
      const latest = await client.getBlockNumber();

      if (cached && latest <= cached.last) return cached;

      const from = cached ? cached.last + 1n : deployBlock;
      const fresh = await scanTrades(client, chain.id, pad, token, from, latest);
      const trades = cached ? [...cached.trades, ...fresh.trades] : fresh.trades;
      const truncated = (cached?.truncated ?? false) || fresh.truncated;

      // timestamps only for blocks we haven't stamped yet (bounded)
      const need = [
        ...new Set(
          trades
            .slice(-300)
            .filter((t) => t.timestamp === 0)
            .map((t) => t.block)
        ),
      ];
      const stamps = new Map<bigint, number>();
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, need.length) }, async () => {
          while (next < need.length) {
            const bn = need[next++];
            const b = await client.getBlock({ blockNumber: bn });
            stamps.set(bn, Number(b.timestamp));
          }
        })
      );
      for (const t of trades) {
        if (t.timestamp === 0) t.timestamp = stamps.get(t.block) ?? 0;
      }

      const result = { trades, truncated };
      saveCache(key, { last: latest, ...result });
      return result;
    },
  });
}

/** Price per whole token implied by each trade, in quote units. */
export function pricePoints(trades: Trade[], quoteDecimals = 18): number[] {
  return trades
    .filter((t) => t.tokens > 0n)
    .map((t) => Number((t.eth * 10n ** 18n) / t.tokens) / 10 ** quoteDecimals);
}
