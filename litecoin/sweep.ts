// Notus on Litecoin — the desk's cold-storage sweep.
//
// The desk address holds everything: the LTC in the curves and pools, the
// credits and payouts it owes (its liabilities), and its own money — the
// treasury: deploy fees, its 20% of trade fees, `fund` gifts. Only the
// treasury is the operator's, and only that leaves here. What is swept is
// the treasury, less a reserve for payout fees, and never so much that the
// confirmed balance would stop covering what the ledger owes. The
// transaction carries the `sweep` memo, so the ledger (rules v2) takes the
// amount off its treasury and every verifier sees the money move.
//
// Run it with the desk service stopped, and no payout transaction in
// flight: the desk and this script must not spend the same coins.
//
//   node litecoin/sweep.ts --to <cold address> [--reserve 0.05] [--max 1.5] [--yes]
//
// Without --yes it only shows what it would send. Environment as payout.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARAMS, memo, rulesV2, type Network } from "../web/lib/litecoin/ledger.ts";
import { PUBLIC_API } from "../web/lib/litecoin/esplora.ts";
import { chainApi, withFallbacks } from "../web/lib/litecoin/chain.ts";
import { DUST_LIT, buildTx, fmtLit, isAddress, walletFromSecret, type Utxo } from "../web/lib/litecoin/tx.ts";
import { deskDir, deskSecret } from "./key.ts";
import { loadIntents } from "./payout.ts";

const ROOT = import.meta.dirname;
const NETWORK: Network = process.env.NOTUS_LTC_NETWORK === "main" ? "main" : "test";
const API = withFallbacks(process.env.NOTUS_LTC_API ?? PUBLIC_API[NETWORK], NETWORK);
const STATE = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");
const SENT = process.env.NOTUS_LTC_SENT ?? join(deskDir(), "sent-payouts.json");

type Snapshot = { desk: { address: string | null }; treasuryLit: string; liabilitiesLit: string; chainTip?: number | null; height: number; updatedAt?: number };

/** LTC the desk may send away: the treasury less the reserve, and never
 *  more than what the confirmed balance holds beyond the liabilities and
 *  the reserve. Zero when there is nothing to spare. */
export function sweepable(confirmedLit: bigint, liabilitiesLit: bigint, treasuryLit: bigint, reserveLit: bigint): bigint {
  const fromTreasury = treasuryLit - reserveLit;
  const fromBalance = confirmedLit - liabilitiesLit - reserveLit;
  const v = fromTreasury < fromBalance ? fromTreasury : fromBalance;
  return v > 0n ? v : 0n;
}

/** `--name value` from the command line, or the default. */
function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

/** An LTC amount on the command line, in lit. */
function lit(v: string, what: string): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(v.trim());
  if (!m) throw new Error(`${what}: not an LTC amount: ${v}`);
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

export async function sweep(log: (line: string) => void = console.log): Promise<string | null> {
  const to = flag("to");
  if (!to || !isAddress(to, NETWORK)) throw new Error(`--to must be a ${NETWORK === "main" ? "mainnet" : "testnet"} Litecoin address`);
  const reserve = lit(flag("reserve", "0.05")!, "--reserve");
  const cap = flag("max") ? lit(flag("max")!, "--max") : null;
  const yes = process.argv.includes("--yes");

  const secret = deskSecret();
  const desk = walletFromSecret(secret, NETWORK);
  const state = JSON.parse(readFileSync(STATE, "utf8")) as Snapshot;
  if (state.desk.address !== desk.address) throw new Error(`snapshot desk ${state.desk.address} is not this key's ${desk.address}`);
  if (to === desk.address) throw new Error("--to is the desk itself");
  const tip = state.chainTip ?? state.height;
  if (!rulesV2(PARAMS[NETWORK], tip + 1)) throw new Error(`the ledger takes a sweep from block ${PARAMS[NETWORK].rulesV2From}; the chain is at ${tip}`);

  // nothing of the desk's in flight: a payout waiting for a block spends coins this must not touch
  const live = loadIntents(SENT).intents.filter((i) => i.status === "sent" || i.status === "rejected");
  if (live.length) throw new Error(`${live.length} payout transaction(s) in flight (${live.map((i) => i.txid.slice(0, 12)).join(", ")}): wait for them to confirm, with the desk stopped`);

  const api = chainApi(API, NETWORK, process.env.NOTUS_LTC_API_KEY);
  const all = await api.utxos(desk.address);
  const confirmed = all.filter((u) => u.confirmed);
  const confirmedLit = confirmed.reduce((t, u) => t + u.value, 0n);
  const owed = BigInt(state.liabilitiesLit);
  const treasury = BigInt(state.treasuryLit);
  let amount = sweepable(confirmedLit, owed, treasury, reserve);
  if (cap !== null && amount > cap) amount = cap;
  log(`desk holds ${fmtLit(confirmedLit)} LTC confirmed · owes ${fmtLit(owed)} LTC · treasury ${fmtLit(treasury)} LTC · reserve ${fmtLit(reserve)} LTC`);
  if (amount < DUST_LIT) {
    log(`nothing to sweep (${fmtLit(amount)} LTC spare)`);
    return null;
  }

  // the fee comes out of the same spare money: send the amount less the fee, so the reserve stays whole
  const feeRate = await api.feeRate();
  const build = (send: bigint) => buildTx({ network: NETWORK, secret, utxos: confirmed as Utxo[], payments: [{ address: to, lit: send }], memo: memo.sweep(), feeRate });
  let built = build(amount);
  if (built.fee > 0n) {
    amount -= built.fee;
    if (amount < DUST_LIT) {
      log(`nothing to sweep once the fee (${fmtLit(built.fee)} LTC) is paid`);
      return null;
    }
    built = build(amount);
  }
  const after = confirmedLit - amount - built.fee;
  if (after < owed + reserve) throw new Error(`refusing: the desk would keep ${fmtLit(after)} LTC against ${fmtLit(owed + reserve)} owed plus reserve`);
  log(`sweep ${fmtLit(amount)} LTC -> ${to} · fee ${fmtLit(built.fee)} LTC (${built.vsize} vB @ ${feeRate}) · desk keeps ${fmtLit(after)} LTC · memo "${memo.sweep()}"`);
  if (!yes) {
    log("dry run: add --yes to broadcast");
    return null;
  }
  const txid = await api.broadcast(built.hex);
  log(`broadcast ${txid}`);
  return txid;
}

if (process.argv[1] && /sweep\.ts$/.test(process.argv[1])) {
  sweep().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
