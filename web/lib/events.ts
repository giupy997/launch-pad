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
import { BLOCK_SECONDS, LAUNCHPAD_DEPLOY_BLOCK, RPC_URLS } from "./config";
import { fallback } from "viem";
import { useAppChain, useLaunchpadAddress } from "./hooks";

export type Trade = {
  type: "buy" | "sell";
  token: `0x${string}`;
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
    // generous timeout: some ranges take >10s when the RPC throttles. Chains
    // with more than one RPC fall through to the next when one refuses; the
    // retries (with backoff, and smaller ranges) are ours, not the transport's.
    const urls = RPC_URLS[chain.id];
    const opts = { timeout: 25_000, retryCount: 0 };
    c = createPublicClient({ chain, transport: urls ? fallback(urls.map((u) => http(u, opts))) : http(undefined, opts) });
    scanClients.set(chain.id, c);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Adaptive eth_getLogs. Public RPCs cap the block range of one call (10k
// blocks on most Base nodes, 100k on GIWA, none on some) and throttle bursts,
// and each node differs. Nothing here assumes a cap: a range the node refuses
// is halved until it is accepted, and the size that works is remembered per
// chain (this tab, and localStorage) so later scans start there. A throttled
// call waits and tries again. A range that keeps failing is reported back,
// not thrown, so a page shows what it has instead of nothing.

type Range = { lo: bigint; hi: bigint };
const DEFAULT_CHUNK = 9_000n; // under the 10k cap of the common public nodes
const MIN_CHUNK = 500n;
const CHUNK_KEY = "notus.getlogs.chunk.";
const chunkSizes = new Map<number, bigint>();

/** the range size this chain's RPCs are known to accept, if learned */
function knownChunk(chainId: number): bigint | undefined {
  const m = chunkSizes.get(chainId);
  if (m !== undefined) return m;
  try {
    const raw = localStorage.getItem(CHUNK_KEY + chainId);
    if (raw) {
      const v = BigInt(raw);
      chunkSizes.set(chainId, v);
      return v;
    }
  } catch {
    /* no storage */
  }
  return undefined;
}

/** remember a size the node accepts (learned from its refusals, never from
 *  a small remainder that happened to pass); only ever shrinks */
function learnChunk(chainId: number, size: bigint) {
  const cur = knownChunk(chainId);
  if (cur !== undefined && cur <= size) return;
  const v = size < MIN_CHUNK ? MIN_CHUNK : size;
  chunkSizes.set(chainId, v);
  try {
    localStorage.setItem(CHUNK_KEY + chainId, v.toString());
  } catch {
    /* no storage */
  }
}

/** [from, to] cut into ranges of at most `size` blocks, most recent first */
function splitRange(from: bigint, to: bigint, size: bigint): Range[] {
  const out: Range[] = [];
  let hi = to;
  while (hi >= from) {
    const lo = hi - size + 1n > from ? hi - size + 1n : from;
    out.push({ lo, hi });
    hi = lo - 1n;
  }
  return out;
}

function errorText(e: unknown): string {
  const err = e as { message?: string; details?: string; shortMessage?: string; cause?: { message?: string } };
  return `${err?.shortMessage ?? ""} ${err?.message ?? ""} ${err?.details ?? ""} ${err?.cause?.message ?? ""}`.toLowerCase();
}
function isThrottle(e: unknown): boolean {
  const t = errorText(e);
  return t.includes("status: 429") || t.includes("too many requests") || t.includes("rate limit") || t.includes("rate-limit");
}
function isRangeError(e: unknown): boolean {
  const t = errorText(e);
  return (
    /block ?range|range (is )?too|too (many|large).*block|max.*(range|blocks)|exceed.*(range|blocks|limit)|more than \d+ (results|logs)|response size|10,?000/.test(t)
  );
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** the logs of `filter` over `ranges`, a few ranges at a time; see above */
async function getLogsAdaptive(
  client: PublicClient,
  chainId: number,
  filter: { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[])[] },
  ranges: Range[],
  concurrency: number
): Promise<{ logs: RpcLog[]; failed: Range[] }> {
  const queue = [...ranges];
  const logs: RpcLog[] = [];
  const failed: Range[] = [];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift()!;
      const span = r.hi - r.lo + 1n;
      const canSplit = span > MIN_CHUNK;
      const split = () => {
        const mid = r.lo + span / 2n;
        queue.push({ lo: r.lo, hi: mid - 1n }, { lo: mid, hi: r.hi });
      };
      for (let attempt = 0; ; attempt++) {
        try {
          const got = (await client.request({
            method: "eth_getLogs",
            params: [{ ...filter, fromBlock: numberToHex(r.lo), toBlock: numberToHex(r.hi) }],
          })) as RpcLog[];
          logs.push(...got);
          break;
        } catch (e) {
          if (isRangeError(e)) {
            // over the node's cap: halve, and start there from now on
            if (!canSplit) {
              failed.push(r);
              break;
            }
            split();
            learnChunk(chainId, span / 2n);
            break;
          }
          const throttled = isThrottle(e);
          // a hiccup that persists, or a throttle that won't ease: smaller pieces
          if (canSplit && attempt >= (throttled ? 2 : 1)) {
            split();
            break;
          }
          if (attempt >= 3) {
            failed.push(r);
            break;
          }
          await sleep(500 * 2 ** attempt + Math.random() * 250);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return { logs, failed };
}

/** The pad's trade logs over [fromBlock, toBlock] — one token's, or (no
 *  token) every coin's — most recent ranges first. A first visit reads at
 *  most MAX_SPAN blocks of history and flags the rest as truncated; the
 *  incremental cache keeps everything from there on. `last` is the newest
 *  block fully covered: when a range kept failing, everything from it up is
 *  left out and will be read by the next scan. */
async function scanTrades(
  client: PublicClient,
  chainId: number,
  pad: `0x${string}`,
  token: `0x${string}` | null,
  fromBlock: bigint,
  toBlock: bigint
): Promise<{ trades: Trade[]; truncated: boolean; last: bigint }> {
  const MAX_SPAN = 250_000n; // ~6 days on Base
  const CONCURRENCY = 3; // higher trips public-RPC rate limits
  // every trade of one token, or (no token) every trade of the pad
  const topics: (`0x${string}` | `0x${string}`[])[] = [[topicBought, topicSold]];
  if (token) topics.push(`0x${token.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`);

  const start = toBlock - fromBlock + 1n > MAX_SPAN ? toBlock - MAX_SPAN + 1n : fromBlock;
  const ranges = splitRange(start, toBlock, knownChunk(chainId) ?? DEFAULT_CHUNK);
  const { logs, failed } = await getLogsAdaptive(client, chainId, { address: pad, topics }, ranges, CONCURRENCY);

  let last = toBlock;
  let kept = logs;
  if (failed.length) {
    const cut = failed.reduce((m, r) => (r.lo < m ? r.lo : m), failed[0].lo);
    kept = logs.filter((l) => BigInt(l.blockNumber ?? "0x0") < cut);
    last = cut - 1n;
  }
  return { trades: decodeTrades(kept), truncated: start > fromBlock, last };
}

function decodeTrades(logs: RpcLog[]): Trade[] {
  return logs
    .map((l) => {
      const d = decodeEventLog({ abi: tradeAbi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
      const base = {
        token: (d.args as { token: `0x${string}` }).token,
        block: BigInt(l.blockNumber ?? "0x0"),
        tx: l.transactionHash as `0x${string}`,
        timestamp: 0,
      };
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

const CACHE_PREFIX = "notus.trades.v2.";
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
      trades: [string, `0x${string}`, string, string, string, `0x${string}`, number, `0x${string}`][];
    };
    return {
      last: BigInt(p.last),
      truncated: p.truncated,
      trades: p.trades.map(([type, trader, eth, tokens, block, tx, timestamp, token]) => ({
        type: type as "buy" | "sell",
        token,
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
      t.token,
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
      saveCache(key, { last: fresh.last, ...result });
      return result;
    },
  });
}

/** The last day's trading of every coin on the pad, summed per token in quote
 *  wei (what buyers paid plus what sellers received): one scan of the recent
 *  blocks in modest chunks, refreshed every minute. For the explore cards. */
export function useVolumes() {
  const chain = useAppChain();
  const pad = useLaunchpadAddress();
  const deployBlock = LAUNCHPAD_DEPLOY_BLOCK[chain.id] ?? 0n;
  return useQuery({
    queryKey: ["volumes-24h", chain.id],
    enabled: !!pad,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
    queryFn: async (): Promise<{ byToken: Record<string, bigint>; trades: number; partial: boolean }> => {
      const byToken: Record<string, bigint> = {};
      if (!pad) return { byToken, trades: 0, partial: false };
      const client = scanClient(chain);
      const latest = await client.getBlockNumber();
      const perDay = BigInt(Math.round(86_400 / (BLOCK_SECONDS[chain.id] ?? 2)));
      const from = latest > deployBlock + perDay ? latest - perDay : deployBlock;
      const ranges = splitRange(from, latest, knownChunk(chain.id) ?? DEFAULT_CHUNK);
      const { logs, failed } = await getLogsAdaptive(
        client,
        chain.id,
        { address: pad, topics: [[topicBought, topicSold]] },
        ranges,
        3
      );
      const trades = decodeTrades(logs);
      for (const t of trades) {
        const k = t.token.toLowerCase();
        byToken[k] = (byToken[k] ?? 0n) + t.eth;
      }
      // a range the RPCs kept refusing leaves the sums short, not absent
      return { byToken, trades: trades.length, partial: failed.length > 0 };
    },
  });
}

/** Price per whole token implied by each trade, in quote units (a float, so a
 *  quote with few decimals keeps its fraction). */
export function pricePoints(trades: Trade[], quoteDecimals = 18): number[] {
  return trades
    .filter((t) => t.tokens > 0n)
    .map((t) => Number(t.eth) / 10 ** quoteDecimals / (Number(t.tokens) / 1e18));
}
