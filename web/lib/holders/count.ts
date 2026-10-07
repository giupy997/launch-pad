import "server-only";
import { createPublicClient, erc20Abi, fallback, http, toEventSelector, type PublicClient } from "viem";
import { getStore } from "@netlify/blobs";
import type { PointsChain } from "../points/chains";
import { latestBlock, scanLogs, type ScanTarget } from "../trades/scan";

// How many wallets hold a coin, counted from the chain itself: every address
// the coin was ever transferred to (its Transfer logs, from the pad's deploy
// block on), then the balance of each, read in one multicall where the chain
// has one. Contracts among the largest balances (the pad with the unsold
// supply, the pool) are not wallets and are taken off. No explorer in the
// loop: Base's sits behind a browser challenge, Liteforge's lags by hours.
//
// The addresses seen, the block read up to and the last count are kept in
// Netlify Blobs, so a request reads only the blocks mined since the last one,
// however old the coin, and asks for no balance at all when no transfer
// happened since; without Blobs (a local run) they live in the instance's
// memory. A long history is read over several requests, each within the
// function's time: `partial` says the count stands for what was read so far.

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const MULTICALL3: Record<number, `0x${string}`> = { 8453: "0xcA11bde05977b3631167028862bE2a173976CA11" };
const CONCURRENCY = 4; // getLogs in flight: a server, but on public nodes
const CHUNKS_PER_ROUND = 16n; // getLogs ranges per round of the scan
const SCAN_BUDGET_MS = 5_500; // no round starts past this: the balances and the save need the rest of the function's ten seconds
const BALANCES_PER_CALL = 500;
const MAX_ADDRESSES = 50_000;

type State = {
  /** the last block whose transfers are in `candidates` */
  last: string;
  /** every address the coin was ever sent to, lowercase */
  candidates: string[];
  /** the coin's creation, unix seconds, from its mint */
  launched: number | null;
  /** the count made with the transfers read up to `at` */
  count?: { holders: number; at: string };
};
const memory = new Map<string, State>();

function store() {
  try {
    return getStore({ name: "holders", consistency: "strong" });
  } catch {
    return null; // not on Netlify: memory only
  }
}
async function load(key: string): Promise<State | null> {
  const m = memory.get(key);
  if (m) return m;
  const st = store();
  if (!st) return null;
  try {
    return (await st.get(key, { type: "json" })) as State | null;
  } catch {
    return null;
  }
}
async function save(key: string, state: State) {
  memory.set(key, state);
  const st = store();
  if (!st) return;
  try {
    await st.setJSON(key, state);
  } catch {
    /* kept in memory for this instance at least */
  }
}

const topicAddress = (topic: string | undefined): string | null => (topic && topic.length === 66 ? `0x${topic.slice(26)}`.toLowerCase() : null);

function client(t: ScanTarget): PublicClient {
  return createPublicClient({
    transport: fallback(t.urls.map((u) => http(u, { timeout: 15_000, retryCount: 1, batch: { batchSize: 30, wait: 16 } }))),
  });
}

/** the balances of `addrs`, in order; a read that fails counts as zero */
async function readBalances(c: PublicClient, chainId: number, token: `0x${string}`, addrs: `0x${string}`[]): Promise<bigint[]> {
  const mc = MULTICALL3[chainId];
  const out: bigint[] = [];
  for (let i = 0; i < addrs.length; i += BALANCES_PER_CALL) {
    const slice = addrs.slice(i, i + BALANCES_PER_CALL);
    const contracts = slice.map((a) => ({ address: token, abi: erc20Abi, functionName: "balanceOf" as const, args: [a] as const }));
    if (mc) {
      const res = await c.multicall({ multicallAddress: mc, allowFailure: true, contracts });
      out.push(...res.map((r) => (r.status === "success" ? (r.result as bigint) : 0n)));
    } else {
      out.push(...(await Promise.all(contracts.map((x) => c.readContract(x).catch(() => 0n)))));
    }
  }
  return out;
}

/** `partial` says the history has not all been read yet: the count stands
 *  for what was read so far, and the next request reads on. */
export async function countHolders(
  chain: PointsChain,
  token: `0x${string}`
): Promise<{ holders: number; launched: number | null; partial: boolean }> {
  const started = Date.now();
  const t: ScanTarget = { chainId: chain.chainId, urls: chain.rpcs, chunk: chain.chunk };
  const c = client(t);
  const key = `${chain.chainId}.${token.toLowerCase()}`;
  const latest = await latestBlock(t);
  const state = (await load(key)) ?? { last: (chain.deployBlock - 1n).toString(), candidates: [], launched: null };
  const candidates = new Set(state.candidates);
  let last = BigInt(state.last);
  let launched = state.launched;
  let moved = 0; // transfers read this request: each one changes a balance

  // the blocks since the last request, a round of ranges at a time while the budget lasts
  while (last < latest && Date.now() - started < SCAN_BUDGET_MS) {
    const from = last + 1n;
    const span = chain.chunk * CHUNKS_PER_ROUND;
    const to = latest - from + 1n > span ? from + span - 1n : latest;
    const r = await scanLogs(t, { address: token, topics: [TRANSFER] }, from, to, CONCURRENCY);
    // the cursor moves on only over a stretch that starts where it stood: a gap would be skipped for good
    if (r.first !== from || r.last < from) break;
    for (const l of r.logs) {
      const to = topicAddress(l.topics[2]);
      if (to && to !== ZERO && to !== DEAD) candidates.add(to);
      // the coin's birth: its first transfer out of nowhere, the mint to the pad
      if (launched === null && topicAddress(l.topics[1]) === ZERO) {
        try {
          const b = await c.getBlock({ blockNumber: BigInt(l.blockNumber ?? "0x0") });
          launched = Number(b.timestamp);
        } catch {
          /* next time */
        }
      }
    }
    moved += r.logs.length;
    last = r.last;
    if (!r.complete) break; // a node left ranges out: the rest on the next request, not now
  }

  const list = [...candidates] as `0x${string}`[];
  const at = last.toString();
  const partial = last < latest;
  if (list.length > MAX_ADDRESSES) {
    await save(key, { last: at, candidates: list, launched });
    throw new Error("too many addresses to count this way");
  }
  // no transfer since the last count: the balances are as they were, the count stands
  const standing = moved === 0 && state.count && state.count.at === state.last ? state.count.holders : null;
  if (standing !== null) {
    if (at !== state.last) await save(key, { last: at, candidates: list, launched, count: { holders: standing, at } });
    return { holders: standing, launched, partial };
  }

  // what was read is kept before the balances are asked for: a function cut short loses none of it
  if (moved || at !== state.last) await save(key, { last: at, candidates: list, launched });
  const balances = await readBalances(c, chain.chainId, token, list);
  const holding = list
    .map((a, i) => ({ a, b: balances[i] ?? 0n }))
    .filter((x) => x.b > 0n)
    .sort((x, y) => (y.b > x.b ? 1 : y.b < x.b ? -1 : 0));
  // the largest balances are where the contracts sit: the pad's unsold supply, the pool
  const probe = holding.slice(0, 8);
  const codes = await Promise.all(probe.map((x) => c.getCode({ address: x.a }).catch(() => undefined)));
  const contracts = probe.filter((_, i) => codes[i] && codes[i] !== "0x").length;
  const holders = Math.max(0, holding.length - contracts);

  await save(key, { last: at, candidates: list, launched, count: { holders, at } });
  return { holders, launched, partial };
}
