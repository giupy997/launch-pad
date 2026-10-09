import "server-only";
import { createPublicClient, erc20Abi, fallback, http, toEventSelector, type PublicClient } from "viem";
import { getStore } from "@netlify/blobs";
import { launchpadAbi } from "../abi";
import type { PointsChain } from "../points/chains";
import { latestBlock, scanLogs, scanLogsWide, type RpcLog, type ScanTarget } from "../trades/scan";

// Who holds a coin, counted from the chain itself: every address the coin
// was ever transferred to (its Transfer logs, from the pad's deploy block
// on), then the balance of each, read in one multicall where the chain has
// one. Contracts among the largest balances (the pad with the unsold supply,
// the pool) are not wallets: they are taken off the count and named in the
// list. No explorer in the loop: Base's sits behind a browser challenge,
// Liteforge's lags by hours. Only the pad's own coins are counted: an
// address the pad does not know is refused before any node is asked.
//
// The transfers are asked for in one request first (one coin's are few, and
// a node that takes the whole span answers at once), else in rounds of
// ranges within a time budget. The addresses seen, the block read up to and
// the last count are kept in Netlify Blobs, so a request reads only the
// blocks mined since the last one, however old the coin, and asks for no
// balance at all when no transfer happened since; without Blobs (a local
// run) they live in the instance's memory. `partial` says the count stands
// for what was read so far: the next request reads on. A count made over
// reads that failed is answered but never kept.
//
// Everything here runs against a budget (the hosting function's ten
// seconds): the rounds stop at a deadline with what they have, the balance
// reads are given the time left and no more, and when they cannot be made
// in it, or fail, the last count kept is answered, as not final, rather
// than nothing. A request that is cut short saves what it read first.

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const MULTICALL3: Record<number, `0x${string}`> = { 8453: "0xcA11bde05977b3631167028862bE2a173976CA11" };
const CONCURRENCY = 4; // getLogs in flight: a server, but on public nodes
const WIDE_MS = 4_000; // the one-request read gives up after this, and the rounds take over
const WIDE_SPAN_SECONDS = 86_400; // a later one-request read is believed over at most a day's blocks
const CHUNKS_PER_ROUND = 16n; // getLogs ranges per round of the scan
const SCAN_BUDGET_MS = 5_500; // the rounds stop here: the balances and the save need the rest of the function's ten seconds
const BUDGET_MS = 8_300; // what a count may take in all, the answer's own time under the function's ten seconds
const BALANCES_MIN_MS = 1_200; // the balances are not asked for in less than this: the last count is answered instead
const RPC_MS = 4_000; // one read on one node: a node that hangs gives way to the next
const BALANCES_PER_CALL = 500; // balanceOf reads per multicall
const SINGLE_READS_AT_ONCE = 30; // without a multicall: one batched request at a time, so one public node is not burst
const MAX_ADDRESSES = 50_000;
const TOP = 100; // holders the answer names, largest first
const PROBE = 8; // the largest balances, checked for code: where the contracts sit

/** the address asked for is not a coin of this pad */
export class UnknownCoinError extends Error {
  constructor() {
    super("not a coin of this launchpad");
  }
}

/** one holder as the answer carries it: address, balance in wei (a decimal string), whether it is a contract */
export type TopHolder = { a: string; b: string; c: boolean };

type State = {
  /** the last block whose transfers are in `candidates` */
  last: string;
  /** every address the coin was ever sent to, lowercase */
  candidates: string[];
  /** the coin's creation, unix seconds, from its mint */
  launched: number | null;
  /** the count made with the transfers read up to `at`, and the largest holders then */
  count?: { holders: number; at: string; top: TopHolder[] };
};
const memory = new Map<string, State>();
const coins = new Set<string>(); // the pad's coins, as confirmed by its curve table

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
    // no retries of the whole chain of nodes: each gets one go, in order
    transport: fallback(
      t.urls.map((u) => http(u, { timeout: RPC_MS, retryCount: 0, batch: { batchSize: 30, wait: 16 } })),
      { retryCount: 0 }
    ),
  });
}

/** `p`, or an error once `deadline` (a time) has passed: the read itself runs on, unheard */
function before<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("out of time")), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** whether the pad knows `token` as one of its coins (its curve exists); remembered once true */
async function isPadCoin(c: PublicClient, chain: PointsChain, token: `0x${string}`): Promise<boolean> {
  const key = `${chain.chainId}.${token.toLowerCase()}`;
  if (coins.has(key)) return true;
  const curve = (await c.readContract({ address: chain.pad, abi: launchpadAbi, functionName: "curves", args: [token] })) as readonly unknown[];
  const known = (curve[0] as bigint) !== 0n; // a virtual reserve of zero: no such curve
  if (known) coins.add(key);
  return known;
}

/** the balances of `addrs`, in order, null where the read failed or the
 *  `deadline` (a time) came first: one multicall where the chain has one,
 *  single reads a batch at a time where it has none or the multicall itself
 *  fails */
async function readBalances(
  c: PublicClient,
  chainId: number,
  token: `0x${string}`,
  addrs: `0x${string}`[],
  deadline: number
): Promise<(bigint | null)[]> {
  const mc = MULTICALL3[chainId];
  const out: (bigint | null)[] = [];
  for (let i = 0; i < addrs.length; i += BALANCES_PER_CALL) {
    const contracts = addrs
      .slice(i, i + BALANCES_PER_CALL)
      .map((a) => ({ address: token, abi: erc20Abi, functionName: "balanceOf" as const, args: [a] as const }));
    let got: (bigint | null)[] | null = null;
    if (Date.now() >= deadline) {
      out.push(...contracts.map(() => null));
      continue;
    }
    if (mc) {
      try {
        const res = await before(c.multicall({ multicallAddress: mc, allowFailure: true, contracts }), deadline);
        got = res.map((r) => (r.status === "success" ? (r.result as bigint) : null));
      } catch {
        got = null; // the single reads, below
      }
    }
    if (!got) {
      got = [];
      for (let j = 0; j < contracts.length; j += SINGLE_READS_AT_ONCE) {
        const part = contracts.slice(j, j + SINGLE_READS_AT_ONCE);
        if (Date.now() >= deadline) {
          got.push(...part.map(() => null));
          continue;
        }
        got.push(...(await Promise.all(part.map((x) => before(c.readContract(x), deadline).then((b) => b as bigint).catch(() => null)))));
      }
    }
    out.push(...got);
  }
  return out;
}

/** what a request did, for the route's debug answer */
export type CountDebug = {
  latest: string;
  from: string;
  last: string;
  wide: boolean;
  moved: number;
  candidates: number;
  /** balance reads or code probes that failed: the count is answered, not kept */
  unreliable: boolean;
  /** the last count kept was answered: no time was left for the balances, or their reads failed */
  previous: boolean;
  ms: number;
};
export type HolderCount = { holders: number; launched: number | null; partial: boolean; top: TopHolder[]; debug: CountDebug };

/** `partial` says the count is not final: the history has not all been
 *  read yet, or a read failed this time; the next request reads on. */
export async function countHolders(chain: PointsChain, token: `0x${string}`): Promise<HolderCount> {
  const started = Date.now();
  const t: ScanTarget = { chainId: chain.chainId, urls: chain.rpcs, chunk: chain.chunk, archive: chain.archive };
  const c = client(t);
  const deadline = started + BUDGET_MS;
  // the first reads under a short deadline of their own: nodes that all hang leave the function nothing to do
  if (!(await before(isPadCoin(c, chain, token), started + 3_000))) throw new UnknownCoinError();
  const key = `${chain.chainId}.${token.toLowerCase()}`;
  const latest = await latestBlock(t, RPC_MS, started + 4_500);
  const state = (await load(key)) ?? { last: (chain.deployBlock - 1n).toString(), candidates: [], launched: null };
  const candidates = new Set(state.candidates);
  let last = BigInt(state.last);
  let launched = state.launched;
  let moved = 0; // transfers read this request: each one changes a balance
  let wide = false;
  let unreliable = false;
  let previous = false;
  const filter = { address: token, topics: [TRANSFER] };
  const debug = (): CountDebug => ({
    latest: latest.toString(),
    from: state.last,
    last: last.toString(),
    wide,
    moved,
    candidates: candidates.size,
    unreliable,
    previous,
    ms: Date.now() - started,
  });

  const absorb = async (logs: RpcLog[]) => {
    for (const l of logs) {
      const to = topicAddress(l.topics[2]);
      if (to && to !== ZERO && to !== DEAD) candidates.add(to);
      // the coin's birth: its first transfer out of nowhere, the mint to the pad
      if (launched === null && topicAddress(l.topics[1]) === ZERO) {
        try {
          const b = await before(c.getBlock({ blockNumber: BigInt(l.blockNumber ?? "0x0") }), deadline);
          launched = Number(b.timestamp);
        } catch {
          /* next time */
        }
      }
    }
    moved += logs.length;
  };

  // The whole stretch in one request, from a node that takes it. Believed
  // when it is a first read with the coin's mint in it (a node that serves
  // only recent blocks leaves the mint out), or a later read over a short
  // stretch; a long later read goes by rounds, where every range is
  // accounted for.
  if (last < latest) {
    const all = await scanLogsWide(t, filter, last + 1n, latest, WIDE_MS);
    if (all) {
      const firstRead = candidates.size === 0 && launched === null;
      const hasMint = all.some((l) => topicAddress(l.topics[1]) === ZERO);
      if (firstRead ? hasMint : latest - last <= BigInt(Math.round(WIDE_SPAN_SECONDS / chain.blockSeconds))) {
        await absorb(all);
        last = latest;
        wide = true;
      }
    }
  }
  // else the blocks since the last request, a round of ranges at a time while the budget lasts
  const scanDeadline = started + SCAN_BUDGET_MS;
  while (last < latest && Date.now() < scanDeadline) {
    const from = last + 1n;
    const span = chain.chunk * CHUNKS_PER_ROUND;
    const to = latest - from + 1n > span ? from + span - 1n : latest;
    const r = await scanLogs(t, filter, from, to, CONCURRENCY, scanDeadline);
    // the cursor moves on only over a stretch that starts where it stood: a gap would be skipped for good
    if (r.first !== from || r.last < from) break;
    await absorb(r.logs);
    last = r.last;
    if (!r.complete) break; // a node left ranges out: the rest on the next request, not now
  }

  const list = [...candidates] as `0x${string}`[];
  const at = last.toString();
  const partial = last < latest;
  // nothing of this request is kept: the state stays as it was, small
  if (list.length > MAX_ADDRESSES) throw new Error("too many addresses to count this way");
  // no transfer since the last count: the balances are as they were, the count stands
  // (a count of nobody over addresses that were seen is not trusted: it is made again)
  const standing =
    moved === 0 && state.count && state.count.at === state.last && (state.count.holders > 0 || state.candidates.length === 0) ? state.count : null;
  if (standing) {
    if (at !== state.last) await save(key, { last: at, candidates: list, launched, count: { ...standing, at } });
    return { holders: standing.holders, launched, partial, top: standing.top, debug: debug() };
  }

  // what was read is kept before the balances are asked for: a function cut short loses none of it
  if (moved || at !== state.last) await save(key, { last: at, candidates: list, launched, count: state.count });
  // the last count kept, for when this request cannot make a better one: answered as not final, the next request tries again
  const fallBack = (): HolderCount | null => {
    if (!state.count) return null;
    previous = true;
    return { holders: state.count.holders, launched, partial: true, top: state.count.top, debug: debug() };
  };
  // the balances need time: in less than a little, the last count is answered instead of a function that dies
  if (deadline - Date.now() < BALANCES_MIN_MS) {
    const fb = fallBack();
    if (fb) return fb;
  }
  const balances = await readBalances(c, chain.chainId, token, list, deadline - 300);
  const failed = balances.filter((b) => b === null).length;
  const holding = list
    .map((a, i) => ({ a, b: balances[i] }))
    .filter((x): x is { a: `0x${string}`; b: bigint } => x.b !== null && x.b > 0n)
    .sort((x, y) => (y.b > x.b ? 1 : y.b < x.b ? -1 : 0));
  // the pad was sent the mint, so somebody always holds: every balance read as zero means the reads are not to be believed
  if (list.length > 0 && holding.length === 0 && failed === 0) throw new Error("no balance could be read");
  // the largest balances are where the contracts sit: the pad's unsold supply, the pool
  const probe = holding.slice(0, PROBE);
  const codes = await Promise.all(
    probe.map((x) =>
      before(c.getCode({ address: x.a }), deadline)
        .then((code) => code ?? "0x")
        .catch(() => null)
    )
  );
  const isContract = new Set(probe.filter((_, i) => codes[i] !== null && codes[i] !== "0x").map((x) => x.a));
  unreliable = failed > 0 || codes.some((x) => x === null);
  // reads that failed undercount: the last count kept, when it counted somebody, is nearer the truth than a short one
  if (unreliable && state.count && state.count.holders > 0) {
    const fb = fallBack();
    if (fb) return fb;
  }
  const holders = Math.max(0, holding.length - isContract.size);
  const top = holding.slice(0, TOP).map((x) => ({ a: x.a, b: x.b.toString(), c: isContract.has(x.a) }));

  // a count over reads that failed is answered (as not final) but not kept: the next request reads the balances again;
  // past the budget it is answered but not kept either, rather than a write that outlives the function
  if (!unreliable && Date.now() < deadline + 400) await save(key, { last: at, candidates: list, launched, count: { holders, at, top } });
  return { holders, launched, partial: partial || unreliable, top, debug: debug() };
}
