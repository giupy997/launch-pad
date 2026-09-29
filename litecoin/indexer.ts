// Notus on Litecoin — the indexer.
//
// Reads every confirmed transaction that touches the desk address from an
// Esplora-style explorer (litecoinspace.org by default), turns each into a
// ledger event, replays the rules and writes the snapshot the website
// serves. Anyone can run the same thing against the same address — or
// their own node — and must get the same state root.
//
//   node litecoin/indexer.ts            one pass
//   node litecoin/indexer.ts --watch    keep going, every 60s
//   node litecoin/indexer.ts --no-sync  replay the local cache only
//
// Environment: NOTUS_LTC_DESK (address; or litecoin/desk/key.json),
// NOTUS_LTC_NETWORK (test|main), NOTUS_LTC_API, NOTUS_LTC_STATE,
// NOTUS_LTC_CACHE, NOTUS_LTC_DESK_DIR, NOTUS_LTC_CONFIRMATIONS (default 2), NOTUS_LTC_FREEZE
// (block height at which the ledger froze for the LitVM migration).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARAMS, replay, snapshot, type Network, type TxEvent } from "../web/lib/litecoin/ledger.ts";
import { PUBLIC_API, eventFromTx, pendingFromTx, type ChainApi, type EsploraTx, type PendingTx } from "../web/lib/litecoin/esplora.ts";
import { Fallback, chainApi } from "../web/lib/litecoin/chain.ts";
import { walletFromSecret } from "../web/lib/litecoin/tx.ts";
import { deskDir, deskSecret, hasDeskKey } from "./key.ts";
import { writeAtomic } from "./files.ts";

const ROOT = import.meta.dirname;
const NETWORK: Network = process.env.NOTUS_LTC_NETWORK === "main" ? "main" : "test";
const API = process.env.NOTUS_LTC_API ?? PUBLIC_API[NETWORK];
export const STATE_PATH = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");
const OUT = STATE_PATH;
const CACHE = process.env.NOTUS_LTC_CACHE ?? join(ROOT, "cache", `${NETWORK}.json`);
/** Transactions fold into the ledger once this deep, so a reorg cannot unwind them. */
const CONFIRMATIONS = Number(process.env.NOTUS_LTC_CONFIRMATIONS ?? 2);
/** Migration freeze height (see Params.freezeHeight); unset = the ledger is live. */
const FREEZE = process.env.NOTUS_LTC_FREEZE ? Number(process.env.NOTUS_LTC_FREEZE) : null;
/** Deeper than this, a cached transaction is taken as final and not re-fetched. */
const SETTLED = 12;
const PAGE = 25; // Esplora's page size for /address/:addr/txs/chain

export function deskAddress(): string {
  if (process.env.NOTUS_LTC_DESK) return process.env.NOTUS_LTC_DESK;
  if (hasDeskKey()) return walletFromSecret(deskSecret(), NETWORK).address;
  throw new Error(`set NOTUS_LTC_DESK to the desk address, or make a key with \`node litecoin/keygen.ts desk\` (looked in ${deskDir()})`);
}

/** A tip this many blocks under the last one is a lagging explorer, not a reorg. */
const LAG_BLOCKS = 6;
/** A tip this far above the last one is an explorer talking nonsense, not a chain that grew. */
const JUMP_BLOCKS = 50_000;

type Cache = {
  desk: string;
  /** The chain tip of the last completed pass: a pass may never go back further than a reorg could. */
  tip?: number;
  /** The freeze height this desk was given, once seen: it must be ahead of the chain when set and never change. */
  freeze?: number;
  /** Confirmed transactions by txid. */
  txs: Record<string, EsploraTx>;
  /** Position of each desk transaction in its block, by block hash. */
  blocks: Record<string, Record<string, number>>;
};

function loadCache(desk: string): Cache {
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8")) as Cache;
    if (c.desk === desk) return c;
  } catch {}
  return { desk, txs: {}, blocks: {} };
}

function saveCache(c: Cache) {
  writeAtomic(CACHE, JSON.stringify(c));
}

/** Walk the address history newest-first. A full walk refreshes everything;
 *  an incremental one stops at the first settled transaction it already has. */
async function fetchTxs(api: ChainApi, desk: string, cache: Cache, tip: number, full: boolean) {
  const fresh: EsploraTx[] = [];
  let last: string | undefined;
  for (;;) {
    const page = await api.addressTxsChain(desk, last);
    let settled = false;
    for (const tx of page) {
      if (!tx.status.confirmed || tx.status.block_height === undefined) continue;
      fresh.push(tx);
      const cached = cache.txs[tx.txid];
      if (!full && cached && cached.status.block_hash === tx.status.block_hash && tx.status.block_height <= tip - SETTLED) settled = true;
    }
    if (settled || page.length < PAGE) break;
    last = page[page.length - 1].txid;
  }
  // A cached transaction missing from the history was either reorged out or
  // forgotten by the explorer. Only the first may be dropped: the block that
  // held it is asked for by height, and a changed hash is the proof.
  const seen = new Set(fresh.map((t) => t.txid));
  for (const [id, tx] of Object.entries(cache.txs)) {
    const h = tx.status.block_height ?? 0;
    if (seen.has(id) || (!full && h <= tip - SETTLED)) continue;
    let gone = false;
    try {
      gone = (await api.blockHash(h)).toLowerCase() !== (tx.status.block_hash ?? "").toLowerCase();
    } catch {
      gone = false; // cannot tell: keep it, ask again next pass
    }
    if (gone) {
      console.log(`[${new Date().toISOString()}] ${id} left the chain (block ${h} reorged): dropped`);
      delete cache.txs[id];
    } else {
      console.log(`[${new Date().toISOString()}] ${id} missing from the history but block ${h} stands: kept (${via(api)})`);
    }
  }
  for (const tx of fresh) cache.txs[tx.txid] = tx;
}

/** Block order matters when two instructions land in the same block. */
async function placeInBlocks(api: ChainApi, cache: Cache) {
  const byBlock = new Map<string, EsploraTx[]>();
  for (const tx of Object.values(cache.txs)) {
    const hash = tx.status.block_hash!;
    if (cache.blocks[hash]?.[tx.txid] === undefined) byBlock.set(hash, [...(byBlock.get(hash) ?? []), tx]);
  }
  for (const [hash, txs] of byBlock) {
    const ids = await api.blockTxids(hash);
    const placed = txs.map((t) => [t.txid, ids.indexOf(t.txid)] as const);
    const missing = placed.filter(([, i]) => i < 0);
    // a position is part of the ledger's order: an explorer that lists the
    // block without one of its transactions gets asked again next pass
    if (missing.length) throw new Error(`block ${hash.slice(0, 16)} does not list ${missing.map(([t]) => t.slice(0, 12)).join(", ")} (${via(api)})`);
    cache.blocks[hash] = { ...cache.blocks[hash], ...Object.fromEntries(placed) };
  }
}

export function eventsFromCache(cache: Cache, desk: string, maxHeight: number): TxEvent[] {
  const events: TxEvent[] = [];
  for (const tx of Object.values(cache.txs)) {
    const h = tx.status.block_height ?? 0;
    if (h === 0 || h > maxHeight) continue;
    events.push(eventFromTx(tx, desk, NETWORK, cache.blocks[tx.status.block_hash!]?.[tx.txid] ?? 0));
  }
  return events;
}

let firstPass = true;
let lastVia = "";
const via = (a: ChainApi) => (a instanceof Fallback ? a.lastUsed || a.label : a.label);
/** One client for the life of the process, so cooldowns and the best tip seen survive between passes. */
let client: ChainApi | null = null;
const theApi = () => (client ??= chainApi(API, NETWORK));

/** One indexer pass: sync (unless told not to), replay, write the snapshot. */
export async function pass(sync: boolean) {
  const desk = deskAddress();
  const api = theApi();
  const cache = loadCache(desk);
  let tip: number | null = null;
  let pending: PendingTx[] = [];
  if (sync) {
    tip = await api.tipHeight();
    if (!Number.isInteger(tip) || tip <= 0) throw new Error(`bad tip ${tip} (${via(api)})`);
    if (cache.tip && tip < cache.tip - LAG_BLOCKS) throw new Error(`explorer behind: tip ${tip}, last pass saw ${cache.tip} (${via(api)})`);
    if (cache.tip && tip > cache.tip + JUMP_BLOCKS) throw new Error(`tip jumped: ${tip}, last pass saw ${cache.tip} (${via(api)}) — delete ${CACHE} if the chain really grew that much`);
    // A freeze is announced ahead of time and then stands: one set behind the
    // chain would rewrite trades already folded in and paid, one that moves
    // would make two replays disagree.
    if (FREEZE !== null) {
      if (!Number.isInteger(FREEZE) || FREEZE <= 0) throw new Error(`bad NOTUS_LTC_FREEZE ${process.env.NOTUS_LTC_FREEZE}`);
      if (cache.freeze === undefined) {
        if (FREEZE < tip) throw new Error(`NOTUS_LTC_FREEZE=${FREEZE} is behind the chain (tip ${tip}): a freeze must be announced for a future block`);
        cache.freeze = FREEZE;
      } else if (cache.freeze !== FREEZE) {
        throw new Error(`NOTUS_LTC_FREEZE changed from ${cache.freeze} to ${FREEZE}: a freeze does not move (delete ${CACHE} to start over)`);
      }
    }
    await fetchTxs(api, desk, cache, tip, firstPass);
    await placeInBlocks(api, cache);
    cache.tip = tip;
    saveCache(cache);
    firstPass = false;
    const now = via(api);
    if (now !== lastVia) {
      lastVia = now;
      console.log(`[${new Date().toISOString()}] reading the chain via ${now}`);
    }
    try {
      // instructions waiting for a block: shown on the site, never folded in
      pending = (await api.addressTxsMempool(desk)).map((t) => pendingFromTx(t, desk, NETWORK)).filter((p): p is PendingTx => p !== null);
    } catch {}
  }
  const maxHeight = tip === null ? Number.MAX_SAFE_INTEGER : tip - (CONFIRMATIONS - 1);
  const events = eventsFromCache(cache, desk, maxHeight);
  const state = replay(NETWORK, events, { ...PARAMS[NETWORK], freezeHeight: FREEZE }, tip === null ? undefined : maxHeight);
  const out = {
    ...snapshot(state),
    desk: { address: desk, network: NETWORK },
    pending: pending.map((p) => ({ ...p, valueLit: p.valueLit.toString() })),
    chainTip: tip,
    confirmations: CONFIRMATIONS,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  let changed = true;
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    changed = prev.stateRoot !== out.stateRoot || prev.chainTip !== out.chainTip || (prev.pending?.length ?? 0) !== pending.length;
  } catch {}
  writeAtomic(OUT, JSON.stringify(out, null, 1));
  if (changed) {
    console.log(
      `[${new Date().toISOString()}] tip ${tip ?? "local"} · ${events.length} txs · ${state.coins.size} coins · ` +
        `${state.payouts.filter((p) => !p.paidTxid).length} payouts due · ${pending.length} pending · root ${out.stateRoot?.slice(0, 16) ?? "-"}`
    );
  }
}

if (process.argv[1] === import.meta.filename) {
  const sync = !process.argv.includes("--no-sync");
  await pass(sync);
  if (process.argv.includes("--watch")) {
    setInterval(() => {
      pass(sync).catch((e) => console.error("pass failed:", (e as Error).message.split("\n")[0]));
    }, 60_000);
  }
}
