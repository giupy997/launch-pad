// Notus on Litecoin — the desk's cold-storage sweep, and the bridge at the migration.
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
//   node litecoin/sweep.ts --to <cold address> [--reserve 0.05] [--max 1.5] [--yes]
//
// At the migration the same tool takes the LTC in the frozen curves and
// pools out — exactly what the migration file says to bridge, less what an
// earlier run already sent — to the address it is bridged to LitVM from,
// with the `bridge` memo: the ledger (rules v2, after the freeze) stops
// counting that LTC as owed here, since the migration owes it on LitVM.
//
//   node litecoin/sweep.ts --bridge litecoin/migration/main-<freeze>.json --to <your address> [--yes]
//
// Run either with the desk service stopped, and no payout transaction in
// flight: the desk and this script must not spend the same coins. Without
// --yes they only show what they would send. Environment as payout.ts.
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

type Snapshot = {
  desk: { address: string | null };
  treasuryLit: string;
  liabilitiesLit: string;
  /** What already left with the `bridge` memo (absent on a snapshot from before the rule). */
  bridgedLit?: string;
  freezeHeight?: number | null;
  chainTip?: number | null;
  height: number;
  updatedAt?: number;
};
/** What migration-snapshot.ts wrote: the part the bridge needs. */
type MigrationFile = { network: string; freezeHeight: number; partial?: boolean; totals: { bridgeWei: string } };

/** LTC the desk may send away: the treasury less the reserve, and never
 *  more than what the confirmed balance holds beyond the liabilities and
 *  the reserve. Zero when there is nothing to spare. */
export function sweepable(confirmedLit: bigint, liabilitiesLit: bigint, treasuryLit: bigint, reserveLit: bigint): bigint {
  const fromTreasury = treasuryLit - reserveLit;
  const fromBalance = confirmedLit - liabilitiesLit - reserveLit;
  const v = fromTreasury < fromBalance ? fromTreasury : fromBalance;
  return v > 0n ? v : 0n;
}

/** LTC still to take to LitVM: what the migration needs there (in wei of
 *  zkLTC, as the file has it), less what the ledger already saw leave with
 *  the `bridge` memo. Zero once it all left. */
export function bridgeLeft(bridgeWei: bigint, bridgedLit: bigint): bigint {
  const need = bridgeWei / 10_000_000_000n; // 18 → 8 decimals, never rounded up
  return need > bridgedLit ? need - bridgedLit : 0n;
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

/** The desk as both commands see it — its key, the snapshot, its confirmed
 *  coins — once the checks either must pass before spending anything. */
async function openDesk(what: "sweep" | "bridge") {
  const to = flag("to");
  if (!to || !isAddress(to, NETWORK)) throw new Error(`--to must be a ${NETWORK === "main" ? "mainnet" : "testnet"} Litecoin address`);
  const reserve = lit(flag("reserve", "0.05")!, "--reserve");
  const yes = process.argv.includes("--yes");

  const secret = deskSecret();
  const desk = walletFromSecret(secret, NETWORK);
  const state = JSON.parse(readFileSync(STATE, "utf8")) as Snapshot;
  if (state.desk.address !== desk.address) throw new Error(`snapshot desk ${state.desk.address} is not this key's ${desk.address}`);
  if (to === desk.address) throw new Error("--to is the desk itself");
  const tip = state.chainTip ?? state.height;
  if (!rulesV2(PARAMS[NETWORK], tip + 1)) throw new Error(`the ledger takes a ${what} from block ${PARAMS[NETWORK].rulesV2From}; the chain is at ${tip}`);

  // nothing of the desk's in flight: a payout waiting for a block spends coins this must not touch
  const live = loadIntents(SENT).intents.filter((i) => i.status === "sent" || i.status === "rejected");
  if (live.length) throw new Error(`${live.length} payout transaction(s) in flight (${live.map((i) => i.txid.slice(0, 12)).join(", ")}): wait for them to confirm, with the desk stopped`);

  const api = chainApi(API, NETWORK, process.env.NOTUS_LTC_API_KEY);
  const all = await api.utxos(desk.address);
  const confirmed = all.filter((u) => u.confirmed) as Utxo[];
  const confirmedLit = confirmed.reduce((t, u) => t + u.value, 0n);
  return { to, reserve, yes, secret, desk, state, tip, api, confirmed, confirmedLit };
}

export async function sweep(log: (line: string) => void = console.log): Promise<string | null> {
  const cap = flag("max") ? lit(flag("max")!, "--max") : null;
  const d = await openDesk("sweep");
  const owed = BigInt(d.state.liabilitiesLit);
  const treasury = BigInt(d.state.treasuryLit);
  let amount = sweepable(d.confirmedLit, owed, treasury, d.reserve);
  if (cap !== null && amount > cap) amount = cap;
  log(`desk holds ${fmtLit(d.confirmedLit)} LTC confirmed · owes ${fmtLit(owed)} LTC · treasury ${fmtLit(treasury)} LTC · reserve ${fmtLit(d.reserve)} LTC`);
  if (amount < DUST_LIT) {
    log(`nothing to sweep (${fmtLit(amount)} LTC spare)`);
    return null;
  }

  // the fee comes out of the same spare money: send the amount less the fee, so the reserve stays whole
  const feeRate = await d.api.feeRate();
  const build = (send: bigint) => buildTx({ network: NETWORK, secret: d.secret, utxos: d.confirmed, payments: [{ address: d.to, lit: send }], memo: memo.sweep(), feeRate });
  let built = build(amount);
  if (built.fee > 0n) {
    amount -= built.fee;
    if (amount < DUST_LIT) {
      log(`nothing to sweep once the fee (${fmtLit(built.fee)} LTC) is paid`);
      return null;
    }
    built = build(amount);
  }
  const after = d.confirmedLit - amount - built.fee;
  if (after < owed + d.reserve) throw new Error(`refusing: the desk would keep ${fmtLit(after)} LTC against ${fmtLit(owed + d.reserve)} owed plus reserve`);
  log(`sweep ${fmtLit(amount)} LTC -> ${d.to} · fee ${fmtLit(built.fee)} LTC (${built.vsize} vB @ ${feeRate}) · desk keeps ${fmtLit(after)} LTC · memo "${memo.sweep()}"`);
  if (!d.yes) {
    log("dry run: add --yes to broadcast");
    return null;
  }
  const txid = await d.api.broadcast(built.hex);
  log(`broadcast ${txid}`);
  return txid;
}

/** The migration's LTC leaves the desk: what the file says to bridge, less
 *  what already left, whole — the desk pays the fee — to the address it is
 *  taken to LitVM from. Only on a frozen ledger past its freeze, from the
 *  file of that very freeze. */
export async function bridge(log: (line: string) => void = console.log): Promise<string | null> {
  const file = flag("bridge")!;
  const mig = JSON.parse(readFileSync(file, "utf8")) as MigrationFile;
  if (mig.network !== NETWORK) throw new Error(`${file} is a ${mig.network} migration; this desk is ${NETWORK}`);
  const d = await openDesk("bridge");
  const { state } = d;
  if (state.freezeHeight == null) throw new Error("the ledger is not frozen: the curves still trade, so there is nothing final to bridge (freeze, snapshot, then bridge)");
  if (d.tip < state.freezeHeight) throw new Error(`the freeze at block ${state.freezeHeight} is not reached (tip ${d.tip}): the ledger only takes a bridge after it`);
  if (mig.freezeHeight !== state.freezeHeight) throw new Error(`${file} is from a freeze at ${mig.freezeHeight}; the ledger is frozen at ${state.freezeHeight}: take the snapshot again`);

  const need = BigInt(mig.totals.bridgeWei);
  const bridged = BigInt(state.bridgedLit ?? "0");
  const amount = bridgeLeft(need, bridged);
  const owed = BigInt(state.liabilitiesLit);
  log(
    `the migration needs ${fmtLit(need / 10_000_000_000n)} LTC on LitVM${mig.partial ? " (a partial file)" : ""} · bridged so far ${fmtLit(bridged)} LTC · desk holds ${fmtLit(d.confirmedLit)} LTC confirmed · owes ${fmtLit(owed)} LTC here`
  );
  if (amount < DUST_LIT) {
    log("nothing left to bridge");
    return null;
  }

  // the desk pays the fee from its own money, so the amount arrives whole;
  // what stays must still cover what the ledger owes here once the curves
  // are off it, plus the reserve for payout fees
  const feeRate = await d.api.feeRate();
  const built = buildTx({ network: NETWORK, secret: d.secret, utxos: d.confirmed, payments: [{ address: d.to, lit: amount }], memo: memo.bridge(), feeRate });
  const after = d.confirmedLit - amount - built.fee;
  const owedAfter = owed > amount ? owed - amount : 0n;
  if (after < owedAfter + d.reserve) throw new Error(`refusing: the desk would keep ${fmtLit(after)} LTC against ${fmtLit(owedAfter + d.reserve)} owed here plus reserve`);
  log(`bridge ${fmtLit(amount)} LTC -> ${d.to} · fee ${fmtLit(built.fee)} LTC (${built.vsize} vB @ ${feeRate}) · desk keeps ${fmtLit(after)} LTC · memo "${memo.bridge()}"`);
  if (!d.yes) {
    log("dry run: add --yes to broadcast");
    return null;
  }
  const txid = await d.api.broadcast(built.hex);
  log(`broadcast ${txid} — once it confirms, take the LTC to LitVM through the bridge, to the account that executes the migration`);
  return txid;
}

if (process.argv[1] && /sweep\.ts$/.test(process.argv[1])) {
  (flag("bridge") ? bridge() : sweep()).catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
