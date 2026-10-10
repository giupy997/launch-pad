// Notus on Litecoin — the desk pays what the ledger says it owes.
//
// Every payout the ledger lists (a sell's proceeds, a claim) is paid by a
// transaction from the desk key carrying `NOTUS1 paid <id> <id>…`; once that
// is mined and folded in, the ledger marks the payouts paid. In between the
// desk must remember what it has sent, or it would pay twice. So:
//   - an INTENT (ids, txid, the signed hex, the coins spent) is written to
//     disk BEFORE the broadcast, never after: a crash in between costs a
//     rebroadcast of the same transaction, never a second payment;
//   - each round, an intent the network does not know is rebroadcast from
//     its stored hex (same txid); one the network keeps refusing is given up
//     only after several rounds, and its payouts are then paid again with a
//     transaction that spends the same coins, so at most one of the two can
//     ever confirm;
//   - only confirmed coins and the desk's own change are spent: nobody
//     else's unconfirmed transaction can pull the rug from under a payout;
//   - a payout the builder cannot pay is set aside on its own, never taking
//     a whole batch down with it;
//   - a payout stuck in the mempool for long is fee-bumped (BIP125), the
//     replacement spending the same coins.
//
//   node litecoin/payout.ts [--dry-run]
//
// Environment: NOTUS_LTC_NETWORK, NOTUS_LTC_API, NOTUS_LTC_STATE, NOTUS_LTC_DESK_DIR,
// NOTUS_LTC_DESK_KEY / NOTUS_LTC_DESK_KEY_FILE (see key.ts), NOTUS_LTC_SENT (the
// intents file, default <desk dir>/sent-payouts.json), NOTUS_LTC_MAX_ROUND_LIT
// (a cap on what one round may pay out, in lit; unset = no cap).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MEMO_MAX_BYTES, memo, memoBytes, type Network } from "../web/lib/litecoin/ledger.ts";
import { PUBLIC_API, isFinal, type ChainApi, type EsploraStatus } from "../web/lib/litecoin/esplora.ts";
import { Fallback, chainApi, withFallbacks } from "../web/lib/litecoin/chain.ts";
import { buildTx, fmtLit, walletFromSecret, type Utxo } from "../web/lib/litecoin/tx.ts";
import { deskDir, deskSecret } from "./key.ts";
import { writeAtomic } from "./files.ts";

const ROOT = import.meta.dirname;
const NETWORK: Network = process.env.NOTUS_LTC_NETWORK === "main" ? "main" : "test";
/** The operator's explorers, then the chain's public ones: one down never stops a round. */
const API = withFallbacks(process.env.NOTUS_LTC_API ?? PUBLIC_API[NETWORK], NETWORK);
const API_KEY = process.env.NOTUS_LTC_API_KEY;
const STATE = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");
const SENT = process.env.NOTUS_LTC_SENT ?? join(deskDir(), "sent-payouts.json");
const MAX_ROUND_LIT = process.env.NOTUS_LTC_MAX_ROUND_LIT ? BigInt(process.env.NOTUS_LTC_MAX_ROUND_LIT) : null;
const MAX_OUTPUTS = 20;
/** Rounds in a row the network must not know a transaction before its payouts are paid again. */
export const GIVE_UP_ROUNDS = 5;
/** Unconfirmed this long, a payout transaction gets a fee bump… */
export const BUMP_AFTER_S = 45 * 60;
/** …if the recommended rate has risen at least this much over what it paid. */
const BUMP_RATIO = 1.25;

type Payout = { id: string; kind: string; to: string; lit: string; txid: string; paidTxid: string | null };
type Snapshot = { payouts: Payout[]; desk: { address: string | null }; liabilitiesLit?: string; chainTip?: number | null; confirmations?: number };

export type IntentInput = { txid: string; vout: number; value: string };
export type Intent = {
  /** The payouts this transaction pays. */
  ids: string[];
  txid: string;
  /** The signed transaction, to rebroadcast; null for records converted from the first edition of this file. */
  hex: string | null;
  inputs: IntentInput[];
  feeRate: number;
  createdAt: number;
  /** sent: broadcast (or believed relayed); rejected: the last broadcast was refused, still watched;
   *  confirmed: the ledger has folded it in; replaced: superseded by a fee bump; dead: given up,
   *  its payouts are due again; unpayable: the builder cannot pay this payout at all. */
  status: "sent" | "rejected" | "confirmed" | "replaced" | "dead" | "unpayable";
  note?: string;
  unknownRounds?: number;
  replacedBy?: string;
  replaces?: string;
};
export type IntentStore = { version: 2; intents: Intent[] };

/** What the desk's /health reports about payouts. */
export type PayoutStatus = { live: number; stuck: number; dead: number; unpayable: number; solvent: boolean | null; lastRound: number | null };
let lastStatus: PayoutStatus = { live: 0, stuck: 0, dead: 0, unpayable: 0, solvent: null, lastRound: null };
export const payoutStatus = (): PayoutStatus => lastStatus;

const LIVE = new Set<Intent["status"]>(["sent", "rejected"]);
/** Intents whose payouts must not be paid (again) by a new transaction. */
const COVERS = new Set<Intent["status"]>(["sent", "rejected", "confirmed", "unpayable"]);

export function loadIntents(path = SENT): IntentStore {
  if (!existsSync(path)) return { version: 2, intents: [] };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (raw && typeof raw === "object" && (raw as IntentStore).version === 2 && Array.isArray((raw as IntentStore).intents)) return raw as IntentStore;
  // the first edition: { "<payout id>": "<txid>" }, nothing else known about the transaction
  const byTxid = new Map<string, string[]>();
  for (const [id, txid] of Object.entries((raw ?? {}) as Record<string, string>)) byTxid.set(txid, [...(byTxid.get(txid) ?? []), id]);
  return { version: 2, intents: [...byTxid].map(([txid, ids]) => ({ ids, txid, hex: null, inputs: [], feeRate: 0, createdAt: 0, status: "sent" })) };
}

export function saveIntents(store: IntentStore, path = SENT) {
  writeAtomic(path, JSON.stringify(store, null, 1));
}

const key = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;
const toInput = (u: Utxo): IntentInput => ({ txid: u.txid, vout: u.vout, value: u.value.toString() });
const fromInput = (i: IntentInput): Utxo => ({ txid: i.txid, vout: i.vout, value: BigInt(i.value), confirmed: true });
const first = (e: unknown) => ((e as Error).message ?? String(e)).split("\n")[0].slice(0, 200);

/** Where a transaction stands: its status, or null when the network does not know it.
 *  Throws when no explorer could answer. */
async function lookup(api: ChainApi, txid: string): Promise<EsploraStatus | null> {
  try {
    return await api.txStatus(txid);
  } catch (e) {
    if (isFinal(e)) return null;
    throw e;
  }
}

/** With several explorers configured, the transaction a payout settles must
 *  be confirmed on every one that answers: one lying or lagging source is
 *  not enough to move real coins. Two answers at least, else no opinion. */
export async function agreedConfirmed(api: ChainApi, txid: string): Promise<boolean | null> {
  if (!(api instanceof Fallback) || api.backends.length < 2) return null;
  // an explorer found down or behind is not asked: its silence, or its stale
  // "unconfirmed", must not hold every payout until it recovers
  const live = api.live();
  const asked = live.length >= 2 ? live : api.backends;
  const answers = await Promise.all(
    asked.map(async (b) => {
      try {
        return await b.txStatus(txid);
      } catch (e) {
        return isFinal(e) ? { confirmed: false } : null;
      }
    })
  );
  const seen = answers.filter((a): a is EsploraStatus => a !== null);
  if (seen.length < 2) return null;
  const heights = new Set(seen.map((a) => (a.confirmed ? a.block_height ?? -1 : -1)));
  return seen.every((a) => a.confirmed) && heights.size === 1;
}

/** Pay (or, dry, list) everything due. Returns how many payouts were broadcast.
 *  `deps` lets a test supply the chain and the clock. */
export async function payDue(dryRun = false, log: (line: string) => void = console.log, deps: { api?: ChainApi; now?: number } = {}): Promise<number> {
  const secret = deskSecret();
  const desk = walletFromSecret(secret, NETWORK);
  const state = JSON.parse(readFileSync(STATE, "utf8")) as Snapshot;
  if (state.desk.address !== desk.address) throw new Error(`snapshot desk ${state.desk.address} is not this key's ${desk.address}`);
  const store = loadIntents();
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const byId = new Map(state.payouts.map((p) => [p.id, p]));
  const api = deps.api ?? chainApi(API, NETWORK, API_KEY);

  // 1. what became of what was sent
  for (const it of store.intents) {
    if (!LIVE.has(it.status)) continue;
    if (it.ids.length && it.ids.every((id) => byId.get(id)?.paidTxid)) {
      it.status = "confirmed";
      continue;
    }
    if (!it.txid) continue;
    let status: EsploraStatus | null;
    try {
      status = await lookup(api, it.txid);
    } catch (e) {
      log(`explorer down while checking ${it.txid.slice(0, 12)}: ${first(e)}`);
      continue;
    }
    if (status) {
      it.unknownRounds = 0;
      if (it.status === "rejected") {
        it.status = "sent";
        it.note = "on the network after all";
      }
      continue;
    }
    if (it.hex && !dryRun) {
      try {
        await api.broadcast(it.hex);
        it.status = "sent";
        it.unknownRounds = 0;
        it.note = `rebroadcast at ${new Date(now * 1000).toISOString()}`;
        log(`rebroadcast ${it.ids.map((i) => `#${i}`).join(" ")} · ${it.txid}`);
        continue;
      } catch (e) {
        it.note = `rebroadcast refused: ${first(e)}`;
        if (!isFinal(e)) continue; // the explorer, not the transaction
        it.status = "rejected";
      }
    }
    if (dryRun) continue; // a dry run observes, it does not give anything up
    it.unknownRounds = (it.unknownRounds ?? 0) + 1;
    if (it.unknownRounds >= GIVE_UP_ROUNDS) {
      it.status = "dead";
      log(`GIVE UP ${it.ids.map((i) => `#${i}`).join(" ")} · ${it.txid}: unknown to the network for ${it.unknownRounds} rounds, due again`);
    }
  }
  if (!dryRun) saveIntents(store);

  // 2. what is due: not paid, not covered by a transaction still in flight
  const covered = new Set(store.intents.filter((i) => COVERS.has(i.status)).flatMap((i) => i.ids));
  const due: Payout[] = [];
  for (const p of state.payouts) {
    if (p.paidTxid || covered.has(p.id)) continue;
    // with several explorers, the sell or claim behind a payout must be confirmed on all of them
    let agree: boolean | null = null;
    try {
      agree = await agreedConfirmed(api, p.txid);
    } catch {}
    if (agree === false) {
      log(`hold #${p.id}: the explorers disagree about ${p.txid.slice(0, 12)}, not paying this round`);
      continue;
    }
    due.push(p);
    log(`due  #${p.id} ${p.kind} ${fmtLit(BigInt(p.lit))} LTC -> ${p.to}`);
  }
  const live = store.intents.filter((i) => LIVE.has(i.status));
  const stuck = live.filter((i) => i.status === "sent" && i.createdAt && now - i.createdAt > BUMP_AFTER_S);
  lastStatus = {
    live: live.length,
    stuck: stuck.length,
    dead: store.intents.filter((i) => i.status === "dead").length,
    unpayable: store.intents.filter((i) => i.status === "unpayable").length,
    solvent: lastStatus.solvent,
    lastRound: now,
  };
  if (due.length === 0 && stuck.length === 0) {
    if (dryRun) log("nothing due");
    return 0;
  }
  if (dryRun) return 0;

  // 3. the coins: confirmed ones and the desk's own change, never a coin a transaction in flight spends
  const feeRate = await api.feeRate();
  const ownTxids = new Set(store.intents.filter((i) => i.status !== "dead").map((i) => i.txid));
  const inFlight = new Set(live.flatMap((i) => i.inputs.map(key)));
  const all = await api.utxos(desk.address);
  let utxos = all.filter((u) => (u.confirmed || ownTxids.has(u.txid)) && !inFlight.has(key(u)));
  const confirmedLit = all.filter((u) => u.confirmed).reduce((t, u) => t + u.value, 0n);
  log(`desk holds ${fmtLit(confirmedLit)} LTC confirmed in ${all.filter((u) => u.confirmed).length} coins · ${utxos.length} spendable · fee ${feeRate} lit/vB`);
  if (state.liabilitiesLit !== undefined) {
    const owed = BigInt(state.liabilitiesLit);
    const solvent = confirmedLit >= owed;
    lastStatus.solvent = solvent;
    if (!solvent) log(`SOLVENCY: the desk holds ${fmtLit(confirmedLit)} LTC confirmed but the ledger owes ${fmtLit(owed)} LTC`);
  }

  let paid = 0;
  let roundLit = 0n;
  const spend = (built: { inputs: Utxo[]; change: bigint; txid: string; outputs: { lit: bigint }[] }) => {
    const spent = new Set(built.inputs.map(key));
    utxos = utxos.filter((u) => !spent.has(key(u)));
    if (built.change > 0n) utxos.push({ txid: built.txid, vout: built.outputs.length - 1, value: built.change, confirmed: false });
  };

  /** Build, record, then broadcast one transaction paying `batch`. */
  const send = async (batch: Payout[], mustSpend: Utxo[], replaces?: Intent): Promise<boolean> => {
    const built = buildTx({
      network: NETWORK,
      secret,
      utxos,
      payments: batch.map((p) => ({ address: p.to, lit: BigInt(p.lit) })),
      memo: memo.paid(batch.map((p) => p.id)),
      feeRate,
      mustSpend,
      rbf: true,
    });
    const intent: Intent = {
      ids: batch.map((p) => p.id),
      txid: built.txid,
      hex: built.hex,
      inputs: built.inputs.map(toInput),
      feeRate: Number(feeRate),
      createdAt: now,
      status: "sent",
      ...(replaces ? { replaces: replaces.txid } : {}),
    };
    store.intents.push(intent);
    if (replaces) {
      replaces.status = "replaced";
      replaces.replacedBy = built.txid;
    }
    saveIntents(store); // before the network hears of it: a crash from here on can only repeat this exact transaction
    try {
      await api.broadcast(built.hex);
    } catch (e) {
      intent.status = isFinal(e) ? "rejected" : "sent";
      intent.note = `broadcast: ${first(e)}`;
      saveIntents(store);
      log(`FAIL ${intent.ids.map((i) => `#${i}`).join(" ")}: ${first(e)}`);
      return false;
    }
    spend(built);
    roundLit += batch.reduce((t, p) => t + BigInt(p.lit), 0n);
    log(`${replaces ? "bumped" : "paid"} ${intent.ids.map((i) => `#${i}`).join(" ")} · ${fmtLit(built.fee)} LTC fee · ${built.txid}`);
    return true;
  };

  // 4. fee bumps for what has waited too long, spending the same coins
  for (const it of stuck) {
    if (!it.hex || it.inputs.length === 0 || Number(feeRate) < it.feeRate * BUMP_RATIO) continue;
    const batch = it.ids.map((id) => byId.get(id)).filter((p): p is Payout => !!p && !p.paidTxid);
    if (batch.length !== it.ids.length) continue;
    try {
      await send(batch, it.inputs.map(fromInput), it);
    } catch (e) {
      log(`no bump for ${it.txid.slice(0, 12)}: ${first(e)}`);
    }
  }

  // 5. the due payouts, in batches: what a memo and a sane output count hold
  const batches: { payouts: Payout[]; mustSpend: Utxo[] }[] = [];
  // …payouts freed by a given-up transaction go together and respend its coins, so the two conflict
  const freed = new Map<string, Intent>();
  for (const it of store.intents) if (it.status === "dead") for (const id of it.ids) freed.set(id, it);
  const spendable = new Set(utxos.map(key));
  const plain: Payout[] = [];
  const byDead = new Map<Intent, Payout[]>();
  for (const p of due) {
    const d = freed.get(p.id);
    if (d) byDead.set(d, [...(byDead.get(d) ?? []), p]);
    else plain.push(p);
  }
  for (const [d, ps] of byDead) batches.push({ payouts: ps, mustSpend: d.inputs.map(fromInput).filter((u) => spendable.has(key(u))) });
  for (const p of plain) {
    const cur = batches.at(-1);
    if (cur && cur.mustSpend.length === 0 && cur.payouts.length < MAX_OUTPUTS && memoBytes(memo.paid([...cur.payouts, p].map((x) => x.id))) <= MEMO_MAX_BYTES) cur.payouts.push(p);
    else batches.push({ payouts: [p], mustSpend: [] });
  }

  for (const b of batches) {
    const lit = b.payouts.reduce((t, p) => t + BigInt(p.lit), 0n);
    if (MAX_ROUND_LIT !== null && roundLit + lit > MAX_ROUND_LIT) {
      log(`round cap: ${fmtLit(roundLit)} LTC paid, ${fmtLit(lit)} LTC more waits for the next round`);
      break;
    }
    try {
      if (await send(b.payouts, b.mustSpend)) paid += b.payouts.length;
    } catch (e) {
      // the batch cannot be built: not enough coins, or one payout the builder refuses
      if (b.payouts.length === 1) {
        const p = b.payouts[0];
        if (/bad address|below dust/.test(first(e))) {
          store.intents.push({ ids: [p.id], txid: "", hex: null, inputs: [], feeRate: 0, createdAt: now, status: "unpayable", note: first(e) });
          saveIntents(store);
          log(`UNPAYABLE #${p.id} -> ${p.to}: ${first(e)}`);
        } else {
          log(`FAIL #${p.id}: ${first(e)}`);
        }
        continue;
      }
      log(`FAIL ${b.payouts.map((p) => `#${p.id}`).join(" ")}: ${first(e)} · trying them one by one`);
      for (const p of b.payouts) {
        try {
          if (await send([p], b.mustSpend)) paid++;
        } catch (e1) {
          if (/bad address|below dust/.test(first(e1))) {
            store.intents.push({ ids: [p.id], txid: "", hex: null, inputs: [], feeRate: 0, createdAt: now, status: "unpayable", note: first(e1) });
            saveIntents(store);
            log(`UNPAYABLE #${p.id} -> ${p.to}: ${first(e1)}`);
          } else {
            log(`FAIL #${p.id}: ${first(e1)}`);
          }
        }
      }
    }
  }
  lastStatus.live = store.intents.filter((i) => LIVE.has(i.status)).length;
  lastStatus.dead = store.intents.filter((i) => i.status === "dead").length;
  lastStatus.unpayable = store.intents.filter((i) => i.status === "unpayable").length;
  return paid;
}

if (process.argv[1] === import.meta.filename) {
  await payDue(process.argv.includes("--dry-run"));
}
