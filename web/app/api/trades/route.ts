import { NextResponse, type NextRequest } from "next/server";
import { parseAbi, type PublicClient } from "viem";
import { POINTS_CHAINS, type PointsChain } from "@/lib/points/chains";
import { client as rpcClient, isPadCoin } from "@/lib/holders/count";
import { SERVICE_MS, servedPadTrades, servedTrades } from "@/lib/points/served";
import { joinHistory } from "@/lib/trades/history";
import { blocksSince } from "@/lib/points/pace";
import { SPAN_CHUNKS, blockTime, latestBlock, packTrades, scanTrades, stampTimestamps, type PoolRef, type ScanTarget, type Trade } from "@/lib/trades/scan";

/** The trades of one coin (its curve and, given its pool, its swaps), or of
 *  the whole pad over the last day (`token=all`, for the explore cards'
 *  volumes), scanned here once and cached at the edge for everyone: a phone
 *  downloads one JSON instead of running dozens of eth_getLogs against a
 *  public node. The browser asks when it has nothing (or is far behind) and
 *  reads the blocks mined since by itself. A warm instance keeps what it
 *  scanned and reads only the new blocks on the next request. The chains come
 *  from lib/points/chains.ts, the table kept free of wagmi for server code; a
 *  chain not in it, or nodes that do not answer, give an error the browser
 *  takes as "scan it yourself". On a chain with no archive node (Liteforge),
 *  one coin's history comes from the points service, which read it without a
 *  time budget (lib/points/served.ts), and the nodes are asked only for the
 *  blocks since: a function's ten seconds read minutes of that chain, not
 *  the days a coin's life spans. */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOL = /^(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{40}):([01])$/;
const KEEP = { token: 1_000, all: 3_000 }; // trades an answer carries at most, the most recent
const CONCURRENCY = 4; // ranges in flight: a server, but on public nodes
const BUDGET_MS = 8_500; // what a request may spend reading, under the hosting function's ten seconds
// Netlify's CDN leaves the query string out of its cache key unless told
// otherwise: without `netlify-vary` every coin would be served the first
// coin's trades. The three parameters that shape the answer, and only those:
// a stray `&x=1` shares the entry rather than costing the nodes a scan.
// `stale`: how long an answer past its seconds is still served while the next is read
// behind it. A whole answer keeps an hour: on a quiet day the first visitor after two
// minutes of nobody waited out the scan itself (seven seconds for Base's day of
// volumes); now they get the last answer at once and the scan runs for the next
// request, which the page makes a minute later. A partial answer keeps its short one.
const WHOLE_STALE = 3_600;
const cache = (seconds: number, stale = seconds * 4) => ({
  "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${stale}`,
  // durable: one entry shared by every edge node, so one scan serves everyone and a
  // stale answer goes out at once while the next scan runs behind it (without it the
  // entry lived on the one node that stored it, and almost every request scanned anew)
  "netlify-cdn-cache-control": `public, durable, s-maxage=${seconds}, stale-while-revalidate=${stale}`,
  "netlify-vary": "query=chain|token|pools",
});
const NO_STORE = { "cache-control": "no-store" };

// A day, and a coin's history, are times; the scans count blocks. The day's blocks are
// searched by their timestamps (lib/points/pace.ts) and kept ten minutes an instance, with
// the configured pace for when the nodes do not say: Base's blocks went from 2 s to 0.2 s
// on 2026-11-05 and the "day" of 43,200 blocks behind the cards' volumes was 2.4 hours for
// six days; Liteforge's pace follows its traffic, and no figure divides its day.
const FRESH_MS = 4_500; // what the read of the blocks since the points service's may take
const COIN_HISTORY_DAYS = 12n; // what a keyed node's fifty chunks reached at 2 s a block
const PACE_MS = 10 * 60_000;
const days = new Map<number, { at: number; blocks: bigint }>();
async function dayBlocks(t: ScanTarget, configuredSeconds: number, latest: bigint, deadline: number): Promise<bigint> {
  const known = days.get(t.chainId);
  if (known && Date.now() - known.at < PACE_MS) return known.blocks;
  const configured = BigInt(Math.round(86_400 / configuredSeconds));
  try {
    const until = Math.min(deadline, Date.now() + 3_000);
    const blocks = await blocksSince((n) => blockTime(t, n, 1_500, until), latest, 86_400, configured);
    days.set(t.chainId, { at: Date.now(), blocks });
    return blocks;
  } catch {
    return known?.blocks ?? configured;
  }
}

type Held = { first: bigint; last: bigint; trades: Trade[]; truncated: boolean };
// keyed by the chain, the token and every pool as named, coin, pair and side: two requests
// share an answer only when they ask for the same thing (SECURITY.md M-09: keyed by the
// pairs alone, a request naming another coin on Notus's pair, or Notus's pair with the
// side flipped, wrote its swaps into the trades served to everyone)
const memory = new Map<string, Held>();

const poolAbi = parseAbi([
  "function graduatedVia(address) view returns (address)",
  "function pairOf(address) view returns (address)",
  "function token0() view returns (address)",
]);
/** pools the chain confirmed, `chain.token.pair.side`: a coin's pool and its sides never change */
const knownPools = new Set<string>();
const poolKey = (chainId: number, x: PoolRef) => `${chainId}.${x.token.toLowerCase()}.${x.pair.toLowerCase()}.${x.tokenIsZero ? 1 : 0}`;
/** Whether every pool named is the pool the pad's migrator seeded for that coin, with
 *  the side the request says: a pool is scanned under a coin's name only when the chain
 *  says it is the coin's. Three reads a pool, once. */
async function poolsAreTheCoins(c: PublicClient, chain: PointsChain, pools: PoolRef[]): Promise<boolean> {
  const unknown = pools.filter((x) => !knownPools.has(poolKey(chain.chainId, x)));
  const checks = await Promise.all(
    unknown.map(async (x) => {
      const via = (await c.readContract({ address: chain.pad, abi: poolAbi, functionName: "graduatedVia", args: [x.token] })) as `0x${string}`;
      if (!via || /^0x0{40}$/.test(via)) return false;
      const [pair, token0] = await Promise.all([
        c.readContract({ address: via, abi: poolAbi, functionName: "pairOf", args: [x.token] }) as Promise<`0x${string}`>,
        c.readContract({ address: x.pair, abi: poolAbi, functionName: "token0" }) as Promise<`0x${string}`>,
      ]);
      const ok = pair.toLowerCase() === x.pair.toLowerCase() && (token0.toLowerCase() === x.token.toLowerCase()) === x.tokenIsZero;
      if (ok) knownPools.add(poolKey(chain.chainId, x));
      return ok;
    })
  );
  return checks.every(Boolean);
}
const MEMORY_KEYS = 64; // answers a warm instance keeps: the oldest goes when a new key comes

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const chainId = Number(p.get("chain"));
  const chain = Object.values(POINTS_CHAINS).find((c) => c.chainId === chainId);
  const token = p.get("token") ?? "";
  const poolsRaw = (p.get("pools") ?? "").split(",").filter(Boolean);
  // sixty pools at most: what a URL carries at ease (87 characters a pool). Twenty refused
  // Liteforge's twenty-five, and its explore page never got the day's volumes from here.
  if (!chain || !(token === "all" || ADDRESS.test(token)) || poolsRaw.length > 60 || !poolsRaw.every((s) => POOL.test(s))) {
    return NextResponse.json({ error: "unknown chain, or a malformed token or pool" }, { status: 400 });
  }
  const pools: PoolRef[] = poolsRaw.map((s) => {
    const m = POOL.exec(s)!;
    return { token: m[1] as `0x${string}`, pair: m[2] as `0x${string}`, tokenIsZero: m[3] === "1" };
  });
  const all = token === "all";
  const coin = all ? null : (token as `0x${string}`);
  // one coin's pools are its own: a pool of another token is not scanned under its name
  if (!all && pools.some((x) => x.token.toLowerCase() !== token.toLowerCase())) {
    return NextResponse.json({ error: "a pool of another token" }, { status: 400 });
  }
  const target: ScanTarget = { chainId, urls: chain.rpcs, chunk: chain.chunk, archive: chain.archive };
  const deadline = Date.now() + BUDGET_MS;
  const key = `${chainId}.${token.toLowerCase()}.${pools.map((x) => `${x.token.toLowerCase()}:${x.pair.toLowerCase()}:${x.tokenIsZero ? 1 : 0}`).sort().join(",")}`;

  try {
    // coins of the pad only, before any scan: a scan costs the nodes the same whatever the
    // address, a read of the curve costs one call and is remembered once true
    const c = rpcClient(target);
    const named = all ? [...new Set(pools.map((x) => x.token.toLowerCase() as `0x${string}`))] : [coin!];
    const known = await Promise.all(named.map((t) => isPadCoin(c, chain, t)));
    if (known.some((k) => !k)) return NextResponse.json({ error: "not a coin of this launchpad" }, { status: 404, headers: cache(300) });
    if (!(await poolsAreTheCoins(c, chain, pools))) {
      return NextResponse.json({ error: "a pool that is not the coin's, or its sides the other way round" }, { status: 404, headers: cache(300) });
    }
    const latest = await latestBlock(target, 2_500, deadline);
    // the pad: the last day, whole or not at all short (a day cut to the scan's fifty chunks
    // would be shown as a day); one coin: the window a browser's first scan reads, and on a
    // chain with a node that keeps its history, twelve days of blocks in one request
    const day = await dayBlocks(target, chain.blockSeconds, latest, deadline);
    const span = all ? day : chain.chunk * SPAN_CHUNKS;
    if (all && day > span) target.wideSpan = day;
    if (!all) target.wideSpan = day * COIN_HISTORY_DAYS;
    const windowStart = latest - span + 1n > chain.deployBlock ? latest - span + 1n : chain.deployBlock;
    const held = memory.get(key);
    let out: Held;
    // the service's history, when the nodes could not give one and nothing is held yet: one
    // coin's trades from its birth, or the whole pad's last day (the cards' volumes; on
    // Liteforge a day is 345,000 blocks, more than its public node scans in time, so the
    // service's own record is the only source of a day there; the pools' swaps are read
    // from the chain from the service's block on, as for one coin)
    const served = all || chain.archive.length || held ? null : await servedTrades(chain.key, coin!, Math.min(SERVICE_MS, deadline - Date.now()));
    const servedPad = !all || chain.archive.length || held ? null : await servedPadTrades(chain.key, Math.min(SERVICE_MS, deadline - Date.now()));
    if (served || servedPad) {
      const history = served
        ? { trades: served.trades, last: BigInt(served.last), graduated: served.graduated === null ? null : BigInt(served.graduated) }
        : { trades: servedPad!.trades, last: BigInt(servedPad!.last), graduated: null };
      // the blocks since the service's are few: a node that does not give them in FRESH_MS is
      // not giving them, and the history in hand is answered without it (flagged as short
      // where a pool's swaps are missing). Given the whole budget, the answer left at 9.7 s
      // on the evening Liteforge's node served no logs, after the browser had stopped waiting.
      const fresh =
        latest > history.last
          ? await scanTrades(target, chain.pad, coin, history.last + 1n, latest, pools, CONCURRENCY, Math.min(deadline, Date.now() + FRESH_MS))
          : null;
      const joined = joinHistory(history, fresh, served !== null && pools.length > 0, all ? BigInt(servedPad!.from) : chain.deployBlock);
      out = { first: joined.first, last: joined.last, trades: joined.trades, truncated: joined.truncated };
    } else if (held && held.first <= windowStart && latest - held.last <= chain.chunk * 10n) {
      // warm: only the blocks mined since the last answer
      if (latest > held.last) {
        const fresh = await scanTrades(target, chain.pad, coin, held.last + 1n, latest, pools, CONCURRENCY, deadline);
        if (fresh.last >= held.last + 1n) {
          held.trades.push(...fresh.trades);
          held.last = fresh.last;
          held.truncated = held.truncated || fresh.truncated;
        }
      }
      out = held;
    } else {
      const fresh = await scanTrades(target, chain.pad, coin, windowStart, latest, pools, CONCURRENCY, deadline);
      if (fresh.last < windowStart) throw new Error("no node served the range");
      out = { first: fresh.first, last: fresh.last, trades: fresh.trades, truncated: fresh.truncated };
    }
    if (all) {
      // the day moves on: what fell out of it goes
      out.trades = out.trades.filter((x) => x.block >= windowStart);
      if (out.first < windowStart) out.first = windowStart;
    } else if (out.first > chain.deployBlock) {
      out.truncated = true; // history before the window is not in this answer
    }
    const keep = all ? KEEP.all : KEEP.token;
    if (out.trades.length > keep) {
      out.trades = out.trades.slice(-keep);
      out.truncated = true;
    }
    await stampTimestamps(target, out.trades, deadline);
    if (!memory.has(key) && memory.size >= MEMORY_KEYS) memory.delete(memory.keys().next().value!);
    memory.set(key, out);
    return NextResponse.json(
      { chain: chainId, token, first: out.first.toString(), last: out.last.toString(), truncated: out.truncated, trades: packTrades(out.trades) },
      { headers: cache(20, out.truncated ? 80 : WHOLE_STALE) }
    );
  } catch {
    return NextResponse.json({ error: "the chain's nodes did not answer" }, { status: 503, headers: NO_STORE });
  }
}
