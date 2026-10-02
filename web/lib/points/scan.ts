// Reading logs from public RPC nodes, for a server. The same lessons as the
// site's lib/events.ts: nodes differ in the block range one eth_getLogs may
// cover (2,000 on mainnet.base.org, far more on Liteforge), some serve only
// recent blocks, all throttle bursts. So every node gets a go at each range,
// a range refused for its size is cut to the size the refusal names (or in
// half) and the size sticks, a throttled node sits out for a moment, and a
// range no node serves is reported, not thrown.

import type { RpcLog } from "./decode.ts";

export class RpcError extends Error {
  readonly code?: number;
  readonly status?: number;
  constructor(message: string, code?: number, status?: number) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.status = status;
  }
}

/** one JSON-RPC call to one node; throws RpcError on any failure */
export type Transport = (url: string, method: string, params: unknown[]) => Promise<unknown>;

type RpcBody = { result?: unknown; error?: { code?: number; message?: string } };

export const fetchTransport: Transport = async (url, method, params) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (e) {
    throw new RpcError(`fetch failed: ${(e as Error).message}`);
  }
  let body: RpcBody | null;
  try {
    body = (await res.json()) as RpcBody;
  } catch {
    body = null;
  }
  if (body?.error) throw new RpcError(String(body.error.message ?? "rpc error"), body.error.code, res.status);
  if (!res.ok) throw new RpcError(`http ${res.status}`, undefined, res.status);
  if (!body || !("result" in body)) throw new RpcError("no result");
  return body.result;
};

export type Range = { lo: bigint; hi: bigint };
export type LogFilter = { address: `0x${string}`; topics: (`0x${string}` | `0x${string}`[] | null)[] };

export const MIN_CHUNK = 500n;
const THROTTLE_COOLDOWN_MS = 4_000;

const text = (e: unknown) => `${(e as Error)?.message ?? e}`.toLowerCase();
export function isThrottle(e: unknown): boolean {
  const t = text(e);
  const status = (e as RpcError)?.status;
  return status === 429 || t.includes("too many requests") || t.includes("rate limit") || t.includes("rate-limit");
}
/** a refusal over the size of the block range (not over its age, or a key) */
export function isRangeError(e: unknown): boolean {
  return /limited to|block ?range|range (is )?too|too (many|large).*block|max.*(range|blocks)|exceed.*(range|blocks|limit)|more than \d+ (results|logs)|response size/.test(
    text(e)
  );
}
/** the range cap a refusal names ("eth_getLogs is limited to a 2,000 range"), if any */
export function capNamed(e: unknown): bigint | null {
  const m = text(e).match(/limited to (?:a )?([\d,]+)|([\d,]+) blocks? (?:range|limit|max)|range (?:of|limit(?: is)?|max(?:imum)?(?: of)?) ([\d,]+)/);
  if (!m) return null;
  const v = BigInt((m[1] ?? m[2] ?? m[3]).replace(/,/g, ""));
  return v >= MIN_CHUNK ? v : null;
}

/** the size to cut a refused range to: just under the cap a node named, else half */
function cutSize(span: bigint, cap: bigint | undefined): bigint {
  return cap !== undefined && cap - 1n < span ? cap - 1n : span / 2n;
}

/** [from, to] cut into ranges of at most `size` blocks, lowest first */
export function splitRange(from: bigint, to: bigint, size: bigint): Range[] {
  const out: Range[] = [];
  let lo = from;
  while (lo <= to) {
    const hi = lo + size - 1n < to ? lo + size - 1n : to;
    out.push({ lo, hi });
    lo = hi + 1n;
  }
  return out;
}

/** the ranges that came back, merged into contiguous stretches, lowest first */
export function stretches(ok: Range[]): Range[] {
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

export type NodesOptions = {
  transport?: Transport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** how long a node that answered "too many requests" sits out */
  throttleCooldownMs?: number;
  /** called when a refusal taught a smaller chunk, so the caller can keep it */
  onChunk?: (size: bigint) => void;
};

/** A chain's public nodes, in order of preference. */
export class Nodes {
  readonly urls: string[];
  private readonly throttledUntil = new Map<string, number>();
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cooldownMs: number;
  private readonly onChunk?: (size: bigint) => void;
  /** blocks one eth_getLogs may cover; only ever shrinks */
  chunk: bigint;

  constructor(urls: string[], chunk: bigint, opts: NodesOptions = {}) {
    if (!urls.length) throw new Error("a chain needs at least one RPC");
    this.urls = urls;
    this.chunk = chunk;
    this.transport = opts.transport ?? fetchTransport;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.cooldownMs = opts.throttleCooldownMs ?? THROTTLE_COOLDOWN_MS;
    this.onChunk = opts.onChunk;
  }

  /** the nodes not sitting out a throttle, in order; all of them when every one is */
  private order(): string[] {
    const now = this.now();
    const free = this.urls.filter((u) => (this.throttledUntil.get(u) ?? 0) <= now);
    return free.length ? free : this.urls;
  }

  private noteThrottle(url: string) {
    this.throttledUntil.set(url, this.now() + this.cooldownMs);
  }

  private learn(size: bigint) {
    const v = size < MIN_CHUNK ? MIN_CHUNK : size;
    if (this.chunk <= v) return;
    this.chunk = v;
    this.onChunk?.(v);
  }

  /** the first node that answers; the last error when none does */
  async call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (const url of this.order()) {
      try {
        return (await this.transport(url, method, params)) as T;
      } catch (e) {
        last = e;
        if (isThrottle(e)) this.noteThrottle(url);
      }
    }
    throw last;
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.call<string>("eth_blockNumber", []));
  }

  /** the timestamp of a block, unix seconds */
  async blockTime(block: bigint): Promise<number> {
    const b = await this.call<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(block), false]);
    if (!b) throw new RpcError(`no block ${block}`);
    return Number(BigInt(b.timestamp));
  }

  /** the logs of `filter` over [from, to], a few ranges at a time: which
   *  ranges came back, and which no node served */
  async getLogs(filter: LogFilter, from: bigint, to: bigint, concurrency = 3): Promise<{ logs: RpcLog[]; ok: Range[]; failed: Range[] }> {
    const queue = splitRange(from, to, this.chunk);
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
          for (const url of this.order()) {
            try {
              const got = (await this.transport(url, "eth_getLogs", [{ ...filter, fromBlock: hex(r.lo), toBlock: hex(r.hi) }])) as RpcLog[];
              logs.push(...got);
              ok.push(r);
              settled = true;
              break;
            } catch (e) {
              if (isThrottle(e)) this.noteThrottle(url);
              else if (isRangeError(e)) {
                tooBig = true;
                const c = capNamed(e);
                if (c !== null && (cap === undefined || c < cap)) cap = c;
              }
            }
          }
          if (settled) break;
          if (tooBig && span > MIN_CHUNK) {
            const size = cutSize(span, cap);
            this.learn(size);
            queue.push(...splitRange(r.lo, r.hi, size));
            settled = true; // handed on in pieces
            break;
          }
          if (attempt < 2) await this.sleep(400 * 2 ** attempt + Math.random() * 200);
        }
        if (!settled) failed.push(r);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
    return { logs, ok, failed };
  }
}

export function hex(n: bigint): `0x${string}` {
  return `0x${n.toString(16)}`;
}
