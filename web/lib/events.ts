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
import { BLOCK_SECONDS, GETLOGS_CHUNK, LAUNCHPAD_DEPLOY_BLOCK, RPC_URLS } from "./config";
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

// ---------------------------------------------------------------------------
// Scanning the chain's logs. Public RPCs differ in what they take: on Base,
// mainnet.base.org serves any block but at most 2,000 per eth_getLogs,
// publicnode takes wide ranges but only recent blocks, and every one of them
// throttles bursts. So the scan talks to each node itself (viem's fallback
// would hide which node refused what, and retry the whole chain on every
// error): a range is cut to the size the chain's nodes take (configured, or
// learned from a node's refusal and kept in localStorage), every node in
// turn gets a go at each range, a node that throttles sits out for a moment,
// and a range no node serves is reported back, not thrown, so a page shows
// what it has.
//
// Log scans use NON-batched clients: some public RPCs (GIWA) queue JSON-RPC
// batch requests containing eth_getLogs for ~10s each, while the same calls
// sent individually answer in well under 2s.

type Node = { url: string; client: PublicClient };
const nodeSets = new Map<number, Node[]>();
function scanNodes(chain: Chain): Node[] {
  let set = nodeSets.get(chain.id);
  if (!set) {
    const urls = RPC_URLS[chain.id] ?? [...chain.rpcUrls.default.http];
    set = urls.map((url) => ({
      url,
      client: createPublicClient({ chain, transport: http(url, { timeout: 25_000, retryCount: 0 }) }),
    }));
    nodeSets.set(chain.id, set);
  }
  return set;
}

// a node that answered "too many requests" sits out for a moment
const THROTTLE_COOLDOWN_MS = 4_000;
const throttledUntil = new Map<string, number>();
function nodesInOrder(set: Node[]): Node[] {
  const now = Date.now();
  const free = set.filter((n) => (throttledUntil.get(n.url) ?? 0) <= now);
  return free.length ? free : set;
}
function noteThrottle(n: Node) {
  throttledUntil.set(n.url, Date.now() + THROTTLE_COOLDOWN_MS);
}

/** the first node that answers; the last error when none does */
async function firstNode<T>(set: Node[], fn: (c: PublicClient) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const n of nodesInOrder(set)) {
    try {
      return await fn(n.client);
    } catch (e) {
      last = e;
      if (isThrottle(e)) noteThrottle(n);
    }
  }
  throw last;
}

type Range = { lo: bigint; hi: bigint };
const DEFAULT_CHUNK = 9_000n; // a guess for chains without a configured size
const MIN_CHUNK = 500n;
const CHUNK_KEY = "notus.getlogs.chunk.";
const chunkSizes = new Map<number, bigint>();

/** the range size this chain's nodes take: learned from a refusal (and kept
 *  in localStorage), else configured, else the guess */
function chunkFor(chainId: number): bigint {
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
  return GETLOGS_CHUNK[chainId] ?? DEFAULT_CHUNK;
}

/** remember a size the nodes take; only ever shrinks */
function learnChunk(chainId: number, size: bigint) {
  const v = size < MIN_CHUNK ? MIN_CHUNK : size;
  if (chunkFor(chainId) <= v) return;
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
/** a refusal over the size of the block range (not over its age, or a key) */
function isRangeError(e: unknown): boolean {
  const t = errorText(e);
  return /limited to|block ?range|range (is )?too|too (many|large).*block|max.*(range|blocks)|exceed.*(range|blocks|limit)|more than \d+ (results|logs)|response size/.test(
    t
  );
}
/** the range cap a refusal names ("eth_getLogs is limited to a 2,000 range"), if any */
function capNamed(e: unknown): bigint | null {
  const m = errorText(e).match(/limited to (?:a )?([\d,]+)|([\d,]+) blocks? (?:range|limit|max)|range (?:of|limit(?: is)?|max(?:imum)?(?: of)?) ([\d,]+)/);
  if (!m) return null;
  const v = BigInt((m[1] ?? m[2] ?? m[3]).replace(/,/g, ""));
  return v >= MIN_CHUNK ? v : null;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** eth_getLogs of `filter` over `ranges`, a few at a time, through the
 *  chain's nodes (see above): which ranges came back, and which didn't */
async function getLogsAdaptive(
  set: Node[],
  chainId: number,
  filter: { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[])[] },
  ranges: Range[],
  concurrency: number
): Promise<{ logs: RpcLog[]; ok: Range[]; failed: Range[] }> {
  const queue = [...ranges];
  const logs: RpcLog[] = [];
  const ok: Range[] = [];
  const failed: Range[] = [];
  const worker = async () => {
    while (queue.length) {
      const r = queue.shift()!;
      const span = r.hi - r.lo + 1n;
      let settled = false;
      for (let attempt = 0; attempt < 3 && !settled; attempt++) {
        let tooBig = false;
        let cap: bigint | null = null;
        for (const n of nodesInOrder(set)) {
          try {
            const got = (await n.client.request({
              method: "eth_getLogs",
              params: [{ ...filter, fromBlock: numberToHex(r.lo), toBlock: numberToHex(r.hi) }],
            })) as RpcLog[];
            logs.push(...got);
            ok.push(r);
            settled = true;
            break;
          } catch (e) {
            if (isThrottle(e)) noteThrottle(n);
            else if (isRangeError(e)) {
              tooBig = true;
              const c = capNamed(e);
              if (c !== null && (cap === null || c < cap)) cap = c;
            }
          }
        }
        if (settled) break;
        if (tooBig && span > MIN_CHUNK) {
          // over a node's cap: cut to the size it named (just under), else in half
          const size = cap !== null && cap - 1n < span ? cap - 1n : span / 2n;
          learnChunk(chainId, size);
          queue.push(...splitRange(r.lo, r.hi, size));
          settled = true; // handed on in pieces
          break;
        }
        if (attempt < 2) await sleep(400 * 2 ** attempt + Math.random() * 200);
      }
      if (!settled) failed.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return { logs, ok, failed };
}

/** the ranges that came back, merged into contiguous stretches, lowest first */
function stretches(ok: Range[]): Range[] {
  const sorted = [...ok].sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi + 1n) {
      if (r.hi > last.hi) last.hi = r.hi;
    } else out.push({ ...r });
  }
  return out;
}

/** The pad's trade logs over [fromBlock, toBlock] — one token's, or (no
 *  token) every coin's. A first visit reads at most MAX_SPAN blocks back and
 *  flags the rest as truncated; the caches keep everything from there on.
 *  What comes back is one contiguous stretch [first, last]: the most recent
 *  one that was read (its top is where the next scan resumes). Blocks no
 *  node served are left out and flagged truncated. */
async function scanTrades(
  set: Node[],
  chainId: number,
  pad: `0x${string}`,
  token: `0x${string}` | null,
  fromBlock: bigint,
  toBlock: bigint
): Promise<{ trades: Trade[]; truncated: boolean; first: bigint; last: bigint }> {
  const MAX_SPAN = 100_000n; // ~2.3 days on Base
  const CONCURRENCY = 3; // higher trips public-RPC rate limits
  // every trade of one token, or (no token) every trade of the pad
  const topics: (`0x${string}` | `0x${string}`[])[] = [[topicBought, topicSold]];
  if (token) topics.push(`0x${token.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`);

  const start = toBlock - fromBlock + 1n > MAX_SPAN ? toBlock - MAX_SPAN + 1n : fromBlock;
  if (start > toBlock) return { trades: [], truncated: false, first: fromBlock, last: fromBlock - 1n };
  const ranges = splitRange(start, toBlock, chunkFor(chainId));
  const { logs, ok, failed } = await getLogsAdaptive(set, chainId, { address: pad, topics }, ranges, CONCURRENCY);
  if (!failed.length) return { trades: decodeTrades(logs), truncated: start > fromBlock, first: start, last: toBlock };

  const got = stretches(ok);
  if (!got.length) return { trades: [], truncated: start > fromBlock, first: fromBlock, last: fromBlock - 1n };
  const seg = got[got.length - 1];
  const kept = logs.filter((l) => {
    const bn = BigInt(l.blockNumber ?? "0x0");
    return bn >= seg.lo && bn <= seg.hi;
  });
  return { trades: decodeTrades(kept), truncated: true, first: seg.lo, last: seg.hi };
}

/** block timestamps for the most recent trades that lack one (bounded; a
 *  block that can't be read now stays unstamped for the next pass) */
async function stampTimestamps(set: Node[], trades: Trade[]) {
  const need = [...new Set(trades.slice(-300).filter((t) => t.timestamp === 0).map((t) => t.block))];
  const stamps = new Map<bigint, number>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, need.length) }, async () => {
      while (next < need.length) {
        const bn = need[next++];
        try {
          const b = await firstNode(set, (c) => c.getBlock({ blockNumber: bn }));
          stamps.set(bn, Number(b.timestamp));
        } catch {
          /* next pass */
        }
      }
    })
  );
  for (const t of trades) {
    if (t.timestamp === 0) t.timestamp = stamps.get(t.block) ?? 0;
  }
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
const VOLUME_MAX_TRADES = 3_000; // a day of the whole pad

type TradeCache = { last: bigint; trades: Trade[]; truncated: boolean };

function cacheKey(chainId: number, token: `0x${string}`): string {
  return `${CACHE_PREFIX}${chainId}.${token.toLowerCase()}`;
}
function volumesKey(chainId: number): string {
  return `${CACHE_PREFIX}${chainId}.all`;
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

function saveCache(key: string, cache: TradeCache, max = CACHE_MAX_TRADES) {
  const kept = cache.trades.slice(-max);
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
      const set = scanNodes(chain);
      const key = cacheKey(chain.id, token);
      const cached = loadCache(key);
      const latest = await firstNode(set, (c) => c.getBlockNumber());

      if (cached && latest <= cached.last) return cached;

      const from = cached ? cached.last + 1n : deployBlock;
      const fresh = await scanTrades(set, chain.id, pad, token, from, latest);
      // nothing new could be read: keep what we have, try again next tick
      if (fresh.last < from) return cached ?? { trades: [], truncated: fresh.truncated };
      const trades = cached ? [...cached.trades, ...fresh.trades] : fresh.trades;
      const truncated = (cached?.truncated ?? false) || fresh.truncated;
      await stampTimestamps(set, trades);

      const result = { trades, truncated };
      saveCache(key, { last: fresh.last, ...result });
      return result;
    },
  });
}

/** The last day's trading of every coin on the pad, summed per token in quote
 *  wei (what buyers paid plus what sellers received), for the explore cards.
 *  One scan of the day on the first visit, then only the blocks mined since
 *  (a localStorage cache, like a token's), refreshed every minute. */
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
      const set = scanNodes(chain);
      const key = volumesKey(chain.id);
      const cached = loadCache(key);
      const latest = await firstNode(set, (c) => c.getBlockNumber());
      const perDay = BigInt(Math.round(86_400 / (BLOCK_SECONDS[chain.id] ?? 2)));
      const dayStart = latest > deployBlock + perDay ? latest - perDay : deployBlock;

      let trades = cached?.trades ?? [];
      let last = cached?.last ?? dayStart - 1n;
      let partial = false;
      if (latest > last) {
        const from = last + 1n > dayStart ? last + 1n : dayStart;
        const fresh = await scanTrades(set, chain.id, pad, null, from, latest);
        if (fresh.last >= from) {
          trades = [...trades, ...fresh.trades];
          last = fresh.last;
        }
        // blocks no node served leave the sums short, not absent
        partial = fresh.last < latest || fresh.truncated;
      }
      trades = trades.filter((t) => t.block >= dayStart);
      saveCache(key, { last, trades, truncated: false }, VOLUME_MAX_TRADES);

      for (const t of trades) {
        const k = t.token.toLowerCase();
        byToken[k] = (byToken[k] ?? 0n) + t.eth;
      }
      return { byToken, trades: trades.length, partial };
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
