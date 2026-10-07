import {
  createPublicClient,
  decodeEventLog,
  encodeEventTopics,
  http,
  numberToHex,
  parseAbiItem,
  type PublicClient,
  type RpcLog,
} from "viem";

// The pad's trades, read from the chain's logs. This module runs in the
// browser (lib/events.ts, the hooks) and on the server (app/api/trades, which
// scans once for everyone and lets the edge cache the answer): it imports no
// React, no wagmi and no site config, and touches localStorage only when
// there is one. A caller says where to read with a ScanTarget.

export type Trade = {
  type: "buy" | "sell";
  token: `0x${string}`;
  trader: `0x${string}`;
  eth: bigint;
  tokens: bigint;
  block: bigint;
  tx: `0x${string}`;
  timestamp: number; // unix seconds, 0 if unknown
  /** where it happened: the pad's curve, or the coin's DEX pool once graduated */
  venue: "curve" | "pool";
};

/** A graduated coin's pool, so its swaps read as the coin's trades: the pair
 *  and which side of it the coin is. */
export type PoolRef = { token: `0x${string}`; pair: `0x${string}`; tokenIsZero: boolean };

/** Where a scan reads: the chain's nodes in order of preference, and the block
 *  range one eth_getLogs may cover there (configured; a node's refusal teaches
 *  a smaller one). The browser builds it from lib/config.ts, the server from
 *  lib/points/chains.ts. */
export type ScanTarget = { chainId: number; urls: readonly string[]; chunk: bigint };

/** how far back a first scan reads, in chunks: ~2.3 days on Base at 1,999
 *  blocks a chunk, ~1.3 on Liteforge's 250 ms blocks at 9,000 */
export const SPAN_CHUNKS = 50n;

const boughtEvent = parseAbiItem(
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee)"
);
const soldEvent = parseAbiItem(
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee)"
);
const tradeAbi = [boughtEvent, soldEvent] as const;
const topicBought = encodeEventTopics({ abi: [boughtEvent] })[0];
const topicSold = encodeEventTopics({ abi: [soldEvent] })[0];
// a Uniswap v2 pair's swap: a graduated coin's trades, read from its pool
const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
);
const topicSwap = encodeEventTopics({ abi: [swapEvent] })[0];

// ---------------------------------------------------------------------------
// Public RPCs differ in what they take: on Base, mainnet.base.org serves any
// block but at most 2,000 per eth_getLogs, publicnode takes wide ranges but
// only recent blocks, and every one of them throttles bursts. So the scan
// talks to each node itself (viem's fallback would hide which node refused
// what, and retry the whole chain on every error): a range is cut to the size
// the chain's nodes take (configured, or learned from a node's refusal), every
// node in turn gets a go at each range, a node that throttles sits out for a
// moment, and a range no node serves is reported back, not thrown, so a page
// shows what it has.
//
// Log scans use NON-batched clients: some public RPCs (GIWA) queue JSON-RPC
// batch requests containing eth_getLogs for ~10s each, while the same calls
// sent individually answer in well under 2s.

type Node = { url: string; client: PublicClient };
const nodeSets = new Map<number, Node[]>();
function scanNodes(t: ScanTarget): Node[] {
  let set = nodeSets.get(t.chainId);
  if (!set) {
    set = t.urls.map((url) => ({
      url,
      client: createPublicClient({ transport: http(url, { timeout: 25_000, retryCount: 0 }) }),
    }));
    nodeSets.set(t.chainId, set);
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

/** the chain's latest block, from the first node that answers */
export function latestBlock(t: ScanTarget): Promise<bigint> {
  return firstNode(scanNodes(t), (c) => c.getBlockNumber());
}

type Range = { lo: bigint; hi: bigint };
const MIN_CHUNK = 500n;
const CHUNK_KEY = "notus.getlogs.chunk.";
const learned = new Map<number, bigint>();
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

/** the range size this chain's nodes take: learned from a refusal (and kept in
 *  the browser's storage, when there is one), else the target's */
function chunkFor(t: ScanTarget): bigint {
  const m = learned.get(t.chainId);
  if (m !== undefined) return m;
  try {
    const raw = storage()?.getItem(CHUNK_KEY + t.chainId);
    if (raw) {
      const v = BigInt(raw);
      learned.set(t.chainId, v);
      return v;
    }
  } catch {
    /* no storage */
  }
  return t.chunk;
}

/** remember a size the nodes take; only ever shrinks */
function learnChunk(t: ScanTarget, size: bigint) {
  const v = size < MIN_CHUNK ? MIN_CHUNK : size;
  if (chunkFor(t) <= v) return;
  learned.set(t.chainId, v);
  try {
    storage()?.setItem(CHUNK_KEY + t.chainId, v.toString());
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

/** the size to cut a refused range to: just under the cap a node named, else half.
 *  (A function on purpose: Next's file tracer evaluates variables' initial
 *  values statically, and `null - 1n` written out crashed the build.) */
function cutSize(span: bigint, cap: bigint | undefined): bigint {
  return cap !== undefined && cap - 1n < span ? cap - 1n : span / 2n;
}

/** eth_getLogs of `filter` over `ranges`, a few at a time, through the
 *  chain's nodes (see above): which ranges came back, and which didn't */
async function getLogsAdaptive(
  set: Node[],
  t: ScanTarget,
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
        let cap: bigint | undefined;
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
              if (c !== null && (cap === undefined || c < cap)) cap = c;
            }
          }
        }
        if (settled) break;
        if (tooBig && span > MIN_CHUNK) {
          // over a node's cap: cut to the size it named (just under), else in half
          const size = cutSize(span, cap);
          learnChunk(t, size);
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

export type Scan = { trades: Trade[]; truncated: boolean; first: bigint; last: bigint };

/** The trade logs over [fromBlock, toBlock] — one token's, or (no token)
 *  every coin's: the pad's Bought and Sold, plus the swaps of every pool in
 *  `pools` (graduated coins trade there, and their trades go on). A first
 *  visit reads at most SPAN_CHUNKS chunks back and flags the rest as
 *  truncated; the caches keep everything from there on. What comes back is
 *  one contiguous stretch [first, last] every scan served: the most recent
 *  one (its top is where the next scan resumes). Blocks a node did not serve
 *  are left out and flagged truncated. `concurrency` is how many ranges are
 *  in flight at once: 3 from a browser (more trips public nodes' limits), a
 *  few more from the server. */
export async function scanTrades(
  t: ScanTarget,
  pad: `0x${string}`,
  token: `0x${string}` | null,
  fromBlock: bigint,
  toBlock: bigint,
  pools: PoolRef[] = [],
  concurrency = 3
): Promise<Scan> {
  const maxSpan = t.chunk * SPAN_CHUNKS;
  // every trade of one token, or (no token) every trade of the pad
  const topics: (`0x${string}` | `0x${string}`[])[] = [[topicBought, topicSold]];
  if (token) topics.push(`0x${token.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`);

  const start = toBlock - fromBlock + 1n > maxSpan ? toBlock - maxSpan + 1n : fromBlock;
  if (start > toBlock) return { trades: [], truncated: false, first: fromBlock, last: fromBlock - 1n };
  const set = scanNodes(t);
  const ranges = splitRange(start, toBlock, chunkFor(t));
  const scans = [
    { logs: [] as RpcLog[], pool: null as PoolRef | null, filter: { address: pad, topics } },
    ...pools.map((pool) => ({ logs: [] as RpcLog[], pool, filter: { address: pool.pair, topics: [topicSwap] } })),
  ];
  // the same ranges for the pad and every pool; a range counts as read only when every scan read it
  const failedKeys = new Set<string>();
  for (const scan of scans) {
    const r = await getLogsAdaptive(set, t, scan.filter, ranges, concurrency);
    scan.logs = r.logs;
    for (const f of r.failed) failedKeys.add(`${f.lo}-${f.hi}`);
  }
  const decodeAll = (within?: Range) =>
    sortTrades(
      scans.flatMap((scan) => {
        const logs = within
          ? scan.logs.filter((l) => {
              const bn = BigInt(l.blockNumber ?? "0x0");
              return bn >= within.lo && bn <= within.hi;
            })
          : scan.logs;
        return scan.pool ? decodeSwaps(logs, scan.pool) : decodeTrades(logs);
      })
    );
  if (!failedKeys.size) return { trades: decodeAll(), truncated: start > fromBlock, first: start, last: toBlock };

  const got = stretches(ranges.filter((r) => !failedKeys.has(`${r.lo}-${r.hi}`)));
  if (!got.length) return { trades: [], truncated: start > fromBlock, first: fromBlock, last: fromBlock - 1n };
  const seg = got[got.length - 1];
  return { trades: decodeAll(seg), truncated: true, first: seg.lo, last: seg.hi };
}

/** The logs of `filter` over [fromBlock, toBlock], read as scanTrades reads
 *  the pad's: the most recent contiguous stretch every node served, with
 *  where it starts and ends, `complete` when nothing was left out. A caller
 *  that keeps a cursor moves it on only when the stretch starts at its
 *  `fromBlock`, or a gap would be skipped for good. */
export async function scanLogs(
  t: ScanTarget,
  filter: { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[])[] },
  fromBlock: bigint,
  toBlock: bigint,
  concurrency = 3
): Promise<{ logs: RpcLog[]; first: bigint; last: bigint; complete: boolean }> {
  if (fromBlock > toBlock) return { logs: [], first: fromBlock, last: fromBlock - 1n, complete: true };
  const r = await getLogsAdaptive(scanNodes(t), t, filter, splitRange(fromBlock, toBlock, chunkFor(t)), concurrency);
  if (!r.failed.length) return { logs: r.logs, first: fromBlock, last: toBlock, complete: true };
  const got = stretches(r.ok);
  if (!got.length) return { logs: [], first: fromBlock, last: fromBlock - 1n, complete: false };
  const seg = got[got.length - 1];
  const within = r.logs.filter((l) => {
    const bn = BigInt(l.blockNumber ?? "0x0");
    return bn >= seg.lo && bn <= seg.hi;
  });
  return { logs: within, first: seg.lo, last: seg.hi, complete: false };
}

/** block timestamps for the most recent trades that lack one (bounded; a
 *  block that can't be read now stays unstamped for the next pass) */
export async function stampTimestamps(t: ScanTarget, trades: Trade[]) {
  const set = scanNodes(t);
  const need = [...new Set(trades.slice(-300).filter((x) => x.timestamp === 0).map((x) => x.block))];
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
  for (const x of trades) {
    if (x.timestamp === 0) x.timestamp = stamps.get(x.block) ?? 0;
  }
}

/** A trade with its place in the chain, for ordering trades from several logs. */
type Keyed = { trade: Trade; block: bigint; index: number };

function sortTrades(keyed: Keyed[]): Trade[] {
  return keyed
    .sort((a, b) => (a.block === b.block ? a.index - b.index : a.block < b.block ? -1 : 1))
    .map((k) => k.trade);
}

function decodeTrades(logs: RpcLog[]): Keyed[] {
  return logs.map((l) => {
    const d = decodeEventLog({ abi: tradeAbi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
    const block = BigInt(l.blockNumber ?? "0x0");
    const base = {
      token: (d.args as { token: `0x${string}` }).token,
      block,
      tx: l.transactionHash as `0x${string}`,
      timestamp: 0,
      venue: "curve" as const,
    };
    const trade: Trade =
      d.eventName === "Bought"
        ? (() => {
            const a = d.args as { buyer: `0x${string}`; ethIn: bigint; tokensOut: bigint };
            return { type: "buy" as const, trader: a.buyer, eth: a.ethIn, tokens: a.tokensOut, ...base };
          })()
        : (() => {
            const a = d.args as { seller: `0x${string}`; tokensIn: bigint; ethOut: bigint };
            return { type: "sell" as const, trader: a.seller, eth: a.ethOut, tokens: a.tokensIn, ...base };
          })();
    return { trade, block, index: Number(l.logIndex ?? 0) };
  });
}

/** A pool's swaps as the coin's trades: quote in and coins out is a buy, coins
 *  in and quote out a sell, by the recipient (the router's `to`: the wallet
 *  behind the swap). Anything else (both sides in, a flash swap) is skipped. */
function decodeSwaps(logs: RpcLog[], pool: PoolRef): Keyed[] {
  const out: Keyed[] = [];
  for (const l of logs) {
    const d = decodeEventLog({ abi: [swapEvent], data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
    const a = d.args as { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint; to: `0x${string}` };
    const [tokensIn, quoteIn] = pool.tokenIsZero ? [a.amount0In, a.amount1In] : [a.amount1In, a.amount0In];
    const [tokensOut, quoteOut] = pool.tokenIsZero ? [a.amount0Out, a.amount1Out] : [a.amount1Out, a.amount0Out];
    const block = BigInt(l.blockNumber ?? "0x0");
    const base = { token: pool.token, trader: a.to, block, tx: l.transactionHash as `0x${string}`, timestamp: 0, venue: "pool" as const };
    let trade: Trade | null = null;
    if (quoteIn > 0n && tokensOut > 0n && tokensIn === 0n) trade = { type: "buy", eth: quoteIn, tokens: tokensOut, ...base };
    else if (tokensIn > 0n && quoteOut > 0n && quoteIn === 0n) trade = { type: "sell", eth: quoteOut, tokens: tokensIn, ...base };
    if (trade) out.push({ trade, block, index: Number(l.logIndex ?? 0) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The compact form trades travel and sleep in: the browser's cache and the
// server's answer, one array per trade, bigints as decimal strings.

export type PackedTrade = [string, `0x${string}`, string, string, string, `0x${string}`, number, `0x${string}`, string];

export function packTrades(trades: Trade[]): PackedTrade[] {
  return trades.map((x) => [x.type, x.trader, x.eth.toString(), x.tokens.toString(), x.block.toString(), x.tx, x.timestamp, x.token, x.venue]);
}

export function unpackTrades(packed: PackedTrade[]): Trade[] {
  return packed.map(([type, trader, eth, tokens, block, tx, timestamp, token, venue]) => ({
    type: type === "sell" ? ("sell" as const) : ("buy" as const),
    token,
    trader,
    eth: BigInt(eth),
    tokens: BigInt(tokens),
    block: BigInt(block),
    tx,
    timestamp,
    venue: venue === "pool" ? ("pool" as const) : ("curve" as const),
  }));
}
