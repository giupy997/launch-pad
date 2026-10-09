import { NextResponse, type NextRequest } from "next/server";
import { POINTS_CHAINS } from "@/lib/points/chains";
import { SPAN_CHUNKS, latestBlock, packTrades, scanTrades, stampTimestamps, type PoolRef, type ScanTarget, type Trade } from "@/lib/trades/scan";

/** The trades of one coin (its curve and, given its pool, its swaps), or of
 *  the whole pad over the last day (`token=all`, for the explore cards'
 *  volumes), scanned here once and cached at the edge for everyone: a phone
 *  downloads one JSON instead of running dozens of eth_getLogs against a
 *  public node. The browser asks when it has nothing (or is far behind) and
 *  reads the blocks mined since by itself. A warm instance keeps what it
 *  scanned and reads only the new blocks on the next request. The chains come
 *  from lib/points/chains.ts, the table kept free of wagmi for server code; a
 *  chain not in it, or nodes that do not answer, give an error the browser
 *  takes as "scan it yourself". */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const POOL = /^(0x[0-9a-fA-F]{40}):(0x[0-9a-fA-F]{40}):([01])$/;
const KEEP = { token: 1_000, all: 3_000 }; // trades an answer carries at most, the most recent
const CONCURRENCY = 4; // ranges in flight: a server, but on public nodes
// Netlify's CDN leaves the query string out of its cache key unless told
// otherwise: without `netlify-vary` every coin would be served the first
// coin's trades.
const cache = (seconds: number) => ({
  "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
  "netlify-cdn-cache-control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
  "netlify-vary": "query",
});

type Held = { first: bigint; last: bigint; trades: Trade[]; truncated: boolean };
const memory = new Map<string, Held>();

export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const chainId = Number(p.get("chain"));
  const chain = Object.values(POINTS_CHAINS).find((c) => c.chainId === chainId);
  const token = p.get("token") ?? "";
  const poolsRaw = (p.get("pools") ?? "").split(",").filter(Boolean);
  if (!chain || !(token === "all" || ADDRESS.test(token)) || poolsRaw.length > 20 || !poolsRaw.every((s) => POOL.test(s))) {
    return NextResponse.json({ error: "unknown chain, or a malformed token or pool" }, { status: 400 });
  }
  const pools: PoolRef[] = poolsRaw.map((s) => {
    const m = POOL.exec(s)!;
    return { token: m[1] as `0x${string}`, pair: m[2] as `0x${string}`, tokenIsZero: m[3] === "1" };
  });
  const all = token === "all";
  const coin = all ? null : (token as `0x${string}`);
  const target: ScanTarget = { chainId, urls: chain.rpcs, chunk: chain.chunk };
  const key = `${chainId}.${token.toLowerCase()}.${pools.map((x) => x.pair.toLowerCase()).sort().join(",")}`;

  try {
    const latest = await latestBlock(target, 4_000);
    // one coin: the same window a browser's first scan reads; the pad: the last day
    const span = all ? BigInt(Math.round(86_400 / chain.blockSeconds)) : chain.chunk * SPAN_CHUNKS;
    const windowStart = latest - span + 1n > chain.deployBlock ? latest - span + 1n : chain.deployBlock;
    const held = memory.get(key);
    let out: Held;
    if (held && held.first <= windowStart && latest - held.last <= chain.chunk * 10n) {
      // warm: only the blocks mined since the last answer
      if (latest > held.last) {
        const fresh = await scanTrades(target, chain.pad, coin, held.last + 1n, latest, pools, CONCURRENCY);
        if (fresh.last >= held.last + 1n) {
          held.trades.push(...fresh.trades);
          held.last = fresh.last;
          held.truncated = held.truncated || fresh.truncated;
        }
      }
      out = held;
    } else {
      const fresh = await scanTrades(target, chain.pad, coin, windowStart, latest, pools, CONCURRENCY);
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
    await stampTimestamps(target, out.trades);
    memory.set(key, out);
    return NextResponse.json(
      { chain: chainId, token, first: out.first.toString(), last: out.last.toString(), truncated: out.truncated, trades: packTrades(out.trades) },
      { headers: cache(20) }
    );
  } catch {
    return NextResponse.json({ error: "the chain's nodes did not answer" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
