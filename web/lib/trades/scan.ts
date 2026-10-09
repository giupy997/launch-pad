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

export type { RpcLog };

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
export type ScanTarget = {
  chainId: number;
  urls: readonly string[];
  chunk: bigint;
  /** the nodes among `urls` that serve the chain's whole history (a keyed
   *  node): a trade scan asks only these for a long span in one request, as
   *  a node that keeps only recent blocks answers such a request with the
   *  old logs silently left out. None in the browser. */
  archive?: readonly string[];
};

/** how far back a first scan reads, in chunks: ~2.3 days on Base at 1,999
 *  blocks a chunk (~11.6 at the 9,999 of a keyed node), ~1.3 on Liteforge's
 *  250 ms blocks at 9,000 */
export const SPAN_CHUNKS = 50n;
/** a scan over more ranges than this tries the whole span in one request first */
const WIDE_FROM_RANGES = 4;
const WIDE_MS = 3_000; // what that one request may take before the ranges take over

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

// a node that answered "too many requests", or did not answer in time, sits
// out for a moment: the next requests go to the others first
const THROTTLE_COOLDOWN_MS = 4_000;
const PER_REQUEST_MS = 4_000; // one eth_getLogs on one node, under a deadline: a node that hangs gives way
const throttledUntil = new Map<string, number>();
function nodesInOrder(set: Node[]): Node[] {
  const now = Date.now();
  const free = set.filter((n) => (throttledUntil.get(n.url) ?? 0) <= now);
  return free.length ? free : set;
}
function noteThrottle(n: Node) {
  throttledUntil.set(n.url, Date.now() + THROTTLE_COOLDOWN_MS);
}

/** a node's host alone: a keyed node's key lives in its path, and never leaves with a log or an answer */
export function nodeName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "a node";
  }
}
/** `text` with every URL cut to its host (viem quotes the request URL in its errors) */
export function redact(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => `https://${nodeName(u)}/…`);
}

/** the last few failures, node (by host) and message, for a route's debug answer */
export const recentScanErrors: string[] = [];
function noteError(url: string, e: unknown) {
  recentScanErrors.push(`${new Date().toISOString().slice(11, 19)} ${nodeName(url)}: ${redact(errorText(e)).replace(/\s+/g, " ").trim().slice(0, 200)}`);
  if (recentScanErrors.length > 20) recentScanErrors.shift();
}

/** the first node that answers; the last error when none does. `perNodeMs`
 *  caps the wait on each node, `deadline` (a time) the whole: a node that
 *  hangs gives way to the next, and sits out the next requests. */
async function firstNode<T>(set: Node[], fn: (c: PublicClient) => Promise<T>, perNodeMs?: number, deadline?: number): Promise<T> {
  let last: unknown = new Error("no node asked in time");
  for (const n of nodesInOrder(set)) {
    const left = deadline === undefined ? Infinity : deadline - Date.now();
    if (left <= 0) break;
    const ms = Math.min(perNodeMs ?? Infinity, left);
    try {
      return await (ms === Infinity ? fn(n.client) : inTime(fn(n.client), ms));
    } catch (e) {
      last = e;
      noteError(n.url, e);
      if (isThrottle(e) || isSlow(e)) noteThrottle(n);
    }
  }
  throw last;
}

/** `p`, or an error after `ms`: the request itself runs on, unheard */
function inTime<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no answer in time")), Math.max(0, ms));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** the chain's latest block, from the first node that answers (each given
 *  `perNodeMs` at most and all of them `deadline`, when said: a server with
 *  a budget asks that way) */
export function latestBlock(t: ScanTarget, perNodeMs?: number, deadline?: number): Promise<bigint> {
  return firstNode(scanNodes(t), (c) => c.getBlockNumber(), perNodeMs, deadline);
}

type Range = { lo: bigint; hi: bigint };
const MIN_CHUNK = 500n;
const CHUNK_KEY = "notus.getlogs.chunk.";
// the range cap learned from a node's refusal, per node: a keyed node that
// takes 10,000 blocks is not held to the 500 a public one named
const learned = new Map<string, bigint>();
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // storage blocked
  }
}

/** the range size the node at `url` takes: learned from its refusal (and
 *  kept in the browser's storage, when there is one), else the target's */
function chunkOf(t: ScanTarget, url: string): bigint {
  const key = `${t.chainId}.${url}`;
  const m = learned.get(key);
  if (m !== undefined) return m;
  try {
    const raw = storage()?.getItem(CHUNK_KEY + key);
    if (raw) {
      const v = BigInt(raw);
      learned.set(key, v);
      return v;
    }
  } catch {
    /* no storage */
  }
  return t.chunk;
}

/** the range size a scan is cut to: what the first node in line takes (the
 *  preferred one, a keyed node where there is one); a range another node
 *  refuses is cut again to its size on the spot */
function chunkFor(t: ScanTarget): bigint {
  const first = nodesInOrder(scanNodes(t))[0];
  return first ? chunkOf(t, first.url) : t.chunk;
}

/** remember a size the node at `url` takes; only ever shrinks */
function learnChunk(t: ScanTarget, url: string, size: bigint) {
  const v = size < MIN_CHUNK ? MIN_CHUNK : size;
  if (chunkOf(t, url) <= v) return;
  const key = `${t.chainId}.${url}`;
  learned.set(key, v);
  try {
    storage()?.setItem(CHUNK_KEY + key, v.toString());
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
/** a node that did not answer in time (ours or viem's timeout) */
function isSlow(e: unknown): boolean {
  const t = errorText(e);
  return t.includes("no answer in time") || t.includes("took too long") || t.includes("timeout") || t.includes("timed out");
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
 *  chain's nodes (see above): which ranges came back, and which didn't. Past
 *  `deadline` (a time, when said) no request starts and none is waited for:
 *  the ranges left count as failed, so a caller with a budget stops in time
 *  and keeps what came back. */
async function getLogsAdaptive(
  set: Node[],
  t: ScanTarget,
  filter: { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[])[] },
  ranges: Range[],
  concurrency: number,
  deadline?: number
): Promise<{ logs: RpcLog[]; ok: Range[]; failed: Range[] }> {
  const queue = [...ranges];
  const logs: RpcLog[] = [];
  const ok: Range[] = [];
  const failed: Range[] = [];
  const left = () => (deadline === undefined ? Infinity : deadline - Date.now());
  const worker = async () => {
    while (queue.length) {
      if (left() <= 0) {
        failed.push(...queue.splice(0));
        return;
      }
      const r = queue.shift()!;
      const span = r.hi - r.lo + 1n;
      let settled = false;
      for (let attempt = 0; attempt < 3 && !settled && left() > 0; attempt++) {
        let tooBig = false;
        let cap: bigint | undefined;
        for (const n of nodesInOrder(set)) {
          if (left() <= 0) break;
          // a range wider than this node is known to take is not even asked of it
          if (span > chunkOf(t, n.url)) {
            tooBig = true;
            const c = chunkOf(t, n.url) + 1n;
            if (cap === undefined || c < cap) cap = c;
            continue;
          }
          try {
            const req = n.client.request({
              method: "eth_getLogs",
              params: [{ ...filter, fromBlock: numberToHex(r.lo), toBlock: numberToHex(r.hi) }],
            }) as Promise<RpcLog[]>;
            // under a deadline no one node gets all the time left: one that hangs gives way to the next
            const got = await (deadline === undefined ? req : inTime(req, Math.min(left(), PER_REQUEST_MS)));
            logs.push(...got);
            ok.push(r);
            settled = true;
            break;
          } catch (e) {
            noteError(n.url, e);
            if (isThrottle(e) || isSlow(e)) noteThrottle(n);
            else if (isRangeError(e)) {
              tooBig = true;
              const c = capNamed(e);
              if (c !== null && (cap === undefined || c < cap)) cap = c;
              // this node's cap, remembered for it alone
              learnChunk(t, n.url, cutSize(span, c ?? undefined));
            }
          }
        }
        if (settled) break;
        if (tooBig && span > MIN_CHUNK) {
          // over a node's cap: cut to the size it named (just under), else in half; the pieces
          // go to the front, so a scan that reads oldest first stays in order
          queue.unshift(...splitRange(r.lo, r.hi, cutSize(span, cap)).reverse());
          settled = true; // handed on in pieces
          break;
        }
        if (attempt < 2 && left() > 1_000) await sleep(400 * 2 ** attempt + Math.random() * 200);
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
 *  few more from the server. A `deadline` (a time) stops the reading there:
 *  the ranges not read by then count as not served. */
export async function scanTrades(
  t: ScanTarget,
  pad: `0x${string}`,
  token: `0x${string}` | null,
  fromBlock: bigint,
  toBlock: bigint,
  pools: PoolRef[] = [],
  concurrency = 3,
  deadline?: number
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
  // a long span in one request first, from a node that serves the whole history (one coin's
  // trades are few): the ranges are spared. Not again once no such node took it.
  let wideWorth = ranges.length > WIDE_FROM_RANGES && !!t.archive?.length;
  for (const scan of scans) {
    const left = deadline === undefined ? Infinity : deadline - Date.now();
    if (wideWorth && left > 500) {
      const wide = await scanLogsWide(t, scan.filter, start, toBlock, Math.min(WIDE_MS, left), t.archive);
      if (wide) {
        scan.logs = wide;
        continue;
      }
      wideWorth = false;
    }
    const r = await getLogsAdaptive(set, t, scan.filter, ranges, concurrency, deadline);
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

/** The logs of `filter` over [fromBlock, toBlock] in one request, from the
 *  first node that takes the whole span: a sparse filter (one coin's
 *  transfers) answers small however long the span, and the chunked scan is
 *  spared. null when no node takes it within `timeoutMs` (a refusal over the
 *  range, a node that does not answer): the caller falls back to scanLogs.
 *  `only` names the nodes to ask (the ones that serve the whole history);
 *  else every node is asked, and the caller judges whether to believe the
 *  answer (a node that keeps only recent blocks leaves old logs out). No
 *  one node gets all the time: a second one is reached when the first hangs. */
export async function scanLogsWide(
  t: ScanTarget,
  filter: { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[])[] },
  fromBlock: bigint,
  toBlock: bigint,
  timeoutMs = 8_000,
  only?: readonly string[]
): Promise<RpcLog[] | null> {
  if (fromBlock > toBlock) return [];
  const deadline = Date.now() + timeoutMs;
  const span = toBlock - fromBlock + 1n;
  const perNode = Math.max(2_000, timeoutMs / 2);
  for (const n of nodesInOrder(scanNodes(t))) {
    if (only && !only.includes(n.url)) continue;
    const left = deadline - Date.now();
    if (left <= 0) break;
    // a node that named a cap under the configured range is known not to take a wide one
    if (chunkOf(t, n.url) < t.chunk) continue;
    try {
      const got = await inTime(
        n.client.request({
          method: "eth_getLogs",
          params: [{ ...filter, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
        }) as Promise<RpcLog[]>,
        Math.min(left, perNode)
      );
      if (Array.isArray(got)) return got;
      noteError(n.url, new Error(`eth_getLogs answered ${typeof got}`));
    } catch (e) {
      noteError(n.url, e);
      // a wide read that ran out of its short time is no mark against the node: it is not benched for it
      if (isThrottle(e)) noteThrottle(n);
      else if (isRangeError(e)) {
        // learned only when sure: the cap the node named, or a refusal of a span it was believed to take.
        // A wide span refused without a figure says nothing about the node's real cap.
        const cap = capNamed(e);
        if (cap !== null) learnChunk(t, n.url, cap - 1n);
        else if (span <= chunkOf(t, n.url)) learnChunk(t, n.url, span / 2n);
      }
    }
  }
  return null;
}

/** The logs of `filter` over [fromBlock, toBlock], read as scanTrades reads
 *  the pad's, oldest range first. `complete` when every range came back;
 *  else one contiguous stretch of what did, with where it starts and ends:
 *  the one starting at `fromBlock` when there is one, so a caller that keeps
 *  a cursor moves it on without skipping a gap for good, else the most
 *  recent. A `deadline` (a time) stops the reading there: what was read by
 *  then comes back, the rest is for the next call. */
export async function scanLogs(
  t: ScanTarget,
  filter: { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[])[] },
  fromBlock: bigint,
  toBlock: bigint,
  concurrency = 3,
  deadline?: number
): Promise<{ logs: RpcLog[]; first: bigint; last: bigint; complete: boolean }> {
  if (fromBlock > toBlock) return { logs: [], first: fromBlock, last: fromBlock - 1n, complete: true };
  // oldest first: cut short, what came back starts where the cursor stood
  const ranges = splitRange(fromBlock, toBlock, chunkFor(t)).reverse();
  const r = await getLogsAdaptive(scanNodes(t), t, filter, ranges, concurrency, deadline);
  if (!r.failed.length) return { logs: r.logs, first: fromBlock, last: toBlock, complete: true };
  const got = stretches(r.ok);
  if (!got.length) return { logs: [], first: fromBlock, last: fromBlock - 1n, complete: false };
  const seg = got[0].lo === fromBlock ? got[0] : got[got.length - 1];
  const within = r.logs.filter((l) => {
    const bn = BigInt(l.blockNumber ?? "0x0");
    return bn >= seg.lo && bn <= seg.hi;
  });
  return { logs: within, first: seg.lo, last: seg.hi, complete: false };
}

/** block timestamps for the most recent trades that lack one (bounded; a
 *  block that can't be read now, or not before `deadline`, stays unstamped
 *  for the next pass) */
export async function stampTimestamps(t: ScanTarget, trades: Trade[], deadline?: number) {
  const set = scanNodes(t);
  const need = [...new Set(trades.slice(-300).filter((x) => x.timestamp === 0).map((x) => x.block))];
  const stamps = new Map<bigint, number>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, need.length) }, async () => {
      while (next < need.length && (deadline === undefined || Date.now() < deadline)) {
        const bn = need[next++];
        try {
          const b = await firstNode(set, (c) => c.getBlock({ blockNumber: bn }), deadline === undefined ? undefined : PER_REQUEST_MS, deadline);
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
