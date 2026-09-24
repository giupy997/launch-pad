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
// NOTUS_LTC_CACHE, NOTUS_LTC_CONFIRMATIONS (default 2).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { replay, snapshot, type Network, type TxEvent } from "../web/lib/litecoin/ledger.ts";
import { Esplora, PUBLIC_API, eventFromTx, type EsploraTx } from "../web/lib/litecoin/esplora.ts";
import { walletFromSecret } from "../web/lib/litecoin/tx.ts";

const ROOT = import.meta.dirname;
const NETWORK: Network = process.env.NOTUS_LTC_NETWORK === "main" ? "main" : "test";
const API = process.env.NOTUS_LTC_API ?? PUBLIC_API[NETWORK];
const OUT = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");
const CACHE = process.env.NOTUS_LTC_CACHE ?? join(ROOT, "cache", `${NETWORK}.json`);
/** Transactions fold into the ledger once this deep, so a reorg cannot unwind them. */
const CONFIRMATIONS = Number(process.env.NOTUS_LTC_CONFIRMATIONS ?? 2);
/** Deeper than this, a cached transaction is taken as final and not re-fetched. */
const SETTLED = 12;
const PAGE = 25; // Esplora's page size for /address/:addr/txs/chain

export function deskAddress(): string {
  if (process.env.NOTUS_LTC_DESK) return process.env.NOTUS_LTC_DESK;
  const keyFile = join(ROOT, "desk/key.json");
  if (existsSync(keyFile)) return walletFromSecret(JSON.parse(readFileSync(keyFile, "utf8")).secret, NETWORK).address;
  throw new Error("set NOTUS_LTC_DESK to the desk address, or make one with `node litecoin/keygen.ts desk`");
}

type Cache = {
  desk: string;
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
  mkdirSync(dirname(CACHE), { recursive: true });
  writeFileSync(CACHE, JSON.stringify(c));
}

/** Walk the address history newest-first. A full walk refreshes everything;
 *  an incremental one stops at the first settled transaction it already has. */
async function fetchTxs(api: Esplora, desk: string, cache: Cache, tip: number, full: boolean) {
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
  // a transaction that recently vanished from the history was reorged out
  const seen = new Set(fresh.map((t) => t.txid));
  for (const [id, tx] of Object.entries(cache.txs)) {
    if ((full || (tx.status.block_height ?? 0) > tip - SETTLED) && !seen.has(id)) delete cache.txs[id];
  }
  for (const tx of fresh) cache.txs[tx.txid] = tx;
}

/** Block order matters when two instructions land in the same block. */
async function placeInBlocks(api: Esplora, cache: Cache) {
  const byBlock = new Map<string, EsploraTx[]>();
  for (const tx of Object.values(cache.txs)) {
    const hash = tx.status.block_hash!;
    if (cache.blocks[hash]?.[tx.txid] === undefined) byBlock.set(hash, [...(byBlock.get(hash) ?? []), tx]);
  }
  for (const [hash, txs] of byBlock) {
    const ids = await api.blockTxids(hash);
    cache.blocks[hash] = { ...cache.blocks[hash], ...Object.fromEntries(txs.map((t) => [t.txid, ids.indexOf(t.txid)])) };
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

async function pass(sync: boolean) {
  const desk = deskAddress();
  const api = new Esplora(API);
  const cache = loadCache(desk);
  let tip: number | null = null;
  if (sync) {
    tip = await api.tipHeight();
    await fetchTxs(api, desk, cache, tip, firstPass);
    await placeInBlocks(api, cache);
    saveCache(cache);
    firstPass = false;
  }
  const maxHeight = tip === null ? Number.MAX_SAFE_INTEGER : tip - (CONFIRMATIONS - 1);
  const events = eventsFromCache(cache, desk, maxHeight);
  const state = replay(NETWORK, events);
  const out = {
    ...snapshot(state),
    desk: { address: desk, network: NETWORK },
    chainTip: tip,
    confirmations: CONFIRMATIONS,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  let changed = true;
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    changed = prev.stateRoot !== out.stateRoot || prev.chainTip !== out.chainTip;
  } catch {}
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  if (changed) {
    console.log(
      `[${new Date().toISOString()}] tip ${tip ?? "local"} · ${events.length} txs · ${state.coins.size} coins · ` +
        `${state.payouts.filter((p) => !p.paidTxid).length} payouts due · root ${out.stateRoot?.slice(0, 16) ?? "-"}`
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
