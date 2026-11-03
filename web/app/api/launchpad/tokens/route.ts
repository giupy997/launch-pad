// The token sync feed for GoPlus (lib/launchpad/sync.ts says what it is):
// GET /api/launchpad/tokens?orderId=0&limit=100 answers the coins the Base
// pad created, in creation order, each with its chain, address and the
// time of the block that created it. Every coin of the pad is in it, the
// ones the site hides included: GoPlus asks which tokens the launchpad
// deployed, not which ones the site lists.
//
// The list and its order are the pad's own (`tokenCount`, `allTokens`), read
// in one batched call on any node: that is the fact, whatever a log scan
// finds. The creation times come from the pad's TokenCreated events, read
// on an archive node only: the public nodes answer an empty list, not an
// error, for blocks older than they keep, and a feed built on that would
// name a coin's time wrong. The keyed node serves the pad's whole history
// (a few dozen logs over a million blocks) in one answer; after that only
// the blocks mined since are read, and the block timestamps come batched.
// Without an archive node, or while one is away, the route says so (503,
// uncached) rather than answer a list it cannot vouch for. The CDN keeps a
// good answer five minutes for everyone (durable), so GoPlus's sync,
// however often it runs, costs the nodes one read in five minutes.
import { NextResponse, type NextRequest } from "next/server";
import { parseAbiItem, type PublicClient } from "viem";
import { POINTS_CHAINS, type PointsChain } from "@/lib/points/chains";
import { client as rpcClient } from "@/lib/holders/count";
import type { ScanTarget } from "@/lib/trades/scan";
import { launchpadAbi } from "@/lib/abi";
import { envelope, itemsOf, page, parseQuery } from "@/lib/launchpad/sync";

export const dynamic = "force-dynamic";

const CHAIN: PointsChain = POINTS_CHAINS.base;
const TOKEN_CREATED = parseAbiItem("event TokenCreated(address indexed token, address indexed creator, string name, string symbol, bool feesToHolders)");
const BUDGET_MS = 8_500; // under the hosting function's ten seconds
const SPAN_MS = 6_000; // one eth_getLogs over the whole span, on the archive node
const SECONDS = 300;
const HEADERS = {
  "cache-control": `public, max-age=${SECONDS}, s-maxage=${SECONDS}, stale-while-revalidate=${SECONDS * 4}`,
  "netlify-cdn-cache-control": `public, durable, s-maxage=${SECONDS}, stale-while-revalidate=${SECONDS * 4}`,
  "netlify-vary": "query=orderId|limit",
};
const NO_STORE = { "cache-control": "no-store" };

/** what this instance has read: the pad's list, each coin's creation block
 *  (by address, lower case) as far as block `last`, and the blocks' times */
type Held = { tokens: `0x${string}`[]; blockOf: Map<string, bigint>; timeOf: Map<bigint, number>; last: bigint };
let held: Held | null = null;

const target = (urls: string[]): ScanTarget => ({ chainId: CHAIN.chainId, urls, chunk: CHAIN.chunk, archive: CHAIN.archive });

/** The pad's list, the entries beyond `have` read in one batched call. */
async function listOf(c: PublicClient, have: `0x${string}`[]): Promise<`0x${string}`[]> {
  const count = Number(await c.readContract({ address: CHAIN.pad, abi: launchpadAbi, functionName: "tokenCount" }));
  if (count <= have.length) return have;
  const more = await Promise.all(
    Array.from({ length: count - have.length }, (_, i) => c.readContract({ address: CHAIN.pad, abi: launchpadAbi, functionName: "allTokens", args: [BigInt(have.length + i)] }))
  );
  return [...have, ...(more as `0x${string}`[])];
}

/** The creation blocks in [from, to], from the archive node, in one call or
 *  in windows of the chain's chunk; throws when it cannot read them all. */
async function creationsIn(from: bigint, to: bigint, deadline: number): Promise<Map<string, bigint>> {
  const c = rpcClient(target(CHAIN.archive));
  const read = (fromBlock: bigint, toBlock: bigint) => c.getLogs({ address: CHAIN.pad, event: TOKEN_CREATED, fromBlock, toBlock });
  const out = new Map<string, bigint>();
  const take = (logs: Awaited<ReturnType<typeof read>>) => {
    for (const l of logs) if (l.args.token && l.blockNumber !== null) out.set(l.args.token.toLowerCase(), l.blockNumber);
  };
  try {
    take(
      await Promise.race([
        read(from, to),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in time")), Math.max(0, Math.min(SPAN_MS, deadline - Date.now())))),
      ])
    );
    return out;
  } catch {
    /* the span was too wide for it: the windows below */
  }
  for (let a = from; a <= to; a += CHAIN.chunk) {
    if (Date.now() > deadline) throw new Error("out of time");
    const b = a + CHAIN.chunk - 1n < to ? a + CHAIN.chunk - 1n : to;
    take(await read(a, b));
  }
  return out;
}

export async function GET(req: NextRequest) {
  const { orderId, limit } = parseQuery(req.nextUrl.searchParams);
  if (!CHAIN.archive.length) {
    return NextResponse.json({ code: 0, message: "no archive node is configured", result: [] }, { status: 503, headers: NO_STORE });
  }
  const deadline = Date.now() + BUDGET_MS;
  try {
    const any = rpcClient(target(CHAIN.rpcs));
    const latest = (await any.getBlockNumber()) - CHAIN.lag;
    const tokens = await listOf(any, held?.tokens ?? []);
    const blockOf = new Map(held?.blockOf ?? []);
    const timeOf = new Map(held?.timeOf ?? []);
    const from = held ? held.last + 1n : CHAIN.deployBlock;
    if (from <= latest) for (const [a, b] of await creationsIn(from, latest, deadline)) blockOf.set(a, b);
    // the time of every creation block not stamped yet, one batched call
    const need = [...new Set([...blockOf.values()].filter((b) => !timeOf.has(b)))];
    for (const [bn, t] of await Promise.all(need.map((bn) => any.getBlock({ blockNumber: bn }).then((b) => [bn, Number(b.timestamp)] as const)))) timeOf.set(bn, t);
    held = { tokens, blockOf, timeOf, last: from <= latest ? latest : held!.last };
    // the list up to the first coin whose creation the logs did not reach: only the newest
    // may be missing (created within the lag, read next time); a gap before that is a bad read
    const created = new Map<string, number>();
    let known = 0;
    for (; known < tokens.length; known++) {
      const b = blockOf.get(tokens[known].toLowerCase());
      const t = b === undefined ? undefined : timeOf.get(b);
      if (t === undefined) break;
      created.set(tokens[known].toLowerCase(), t);
    }
    if (tokens.length - known > 2) throw new Error("the creation events do not cover the pad's list");
    return NextResponse.json(envelope(page(itemsOf(CHAIN.chainId, tokens.slice(0, known), created), orderId, limit)), { headers: HEADERS });
  } catch {
    // nothing to answer with: said so, uncached, so the next call reads again
    return NextResponse.json({ code: 0, message: "the chain's nodes did not answer", result: [] }, { status: 503, headers: NO_STORE });
  }
}
