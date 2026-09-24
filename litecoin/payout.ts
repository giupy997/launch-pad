// Notus on Litecoin — the desk's spend path.
//
// Pays every payout the ledger says is due (sell proceeds and claims): one
// transaction per batch, one output per payout, and the memo `NOTUS1 paid
// <ids>` so the payment itself is what marks them settled when the indexer
// next replays the chain. The desk key never leaves this machine.
//
//   node litecoin/payout.ts            pay what is due
//   node litecoin/payout.ts --dry-run  only list it
//
// Environment: NOTUS_LTC_DESK_KEY (hex secret; or litecoin/desk/key.json),
// NOTUS_LTC_NETWORK, NOTUS_LTC_API, NOTUS_LTC_STATE.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMO_MAX_BYTES, memo, memoBytes, type Network } from "../web/lib/litecoin/ledger.ts";
import { Esplora, PUBLIC_API } from "../web/lib/litecoin/esplora.ts";
import { buildTx, fmtLit, walletFromSecret, type Utxo } from "../web/lib/litecoin/tx.ts";

const ROOT = import.meta.dirname;
const NETWORK: Network = process.env.NOTUS_LTC_NETWORK === "main" ? "main" : "test";
const API = process.env.NOTUS_LTC_API ?? PUBLIC_API[NETWORK];
const STATE = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");
// A payout stays "due" in the ledger until its payment is mined and folded
// in, so remember what was already broadcast or it would be paid twice.
const SENT = join(ROOT, "desk/sent-payouts.json");
const MAX_OUTPUTS = 20;

type Payout = { id: number; kind: string; to: string; lit: string; paidTxid: string | null };

const secret = process.env.NOTUS_LTC_DESK_KEY ?? JSON.parse(readFileSync(join(ROOT, "desk/key.json"), "utf8")).secret;
const desk = walletFromSecret(secret, NETWORK);
const dryRun = process.argv.includes("--dry-run");
const state = JSON.parse(readFileSync(STATE, "utf8")) as { payouts: Payout[]; desk: { address: string } };
if (state.desk.address !== desk.address) throw new Error(`snapshot desk ${state.desk.address} is not this key's ${desk.address}`);
const sent: Record<string, string> = existsSync(SENT) ? JSON.parse(readFileSync(SENT, "utf8")) : {};
const due = state.payouts.filter((p) => !p.paidTxid && !(p.id in sent));

if (due.length === 0) console.log("nothing due");
for (const p of due) console.log(`due  #${p.id} ${p.kind} ${fmtLit(BigInt(p.lit))} LTC -> ${p.to}`);
if (dryRun || due.length === 0) process.exit(0);

// batches: as many as fit the memo and a sane output count
const batches: Payout[][] = [];
for (const p of due) {
  const cur = batches.at(-1);
  if (cur && cur.length < MAX_OUTPUTS && memoBytes(memo.paid([...cur, p].map((x) => x.id))) <= MEMO_MAX_BYTES) cur.push(p);
  else batches.push([p]);
}

const api = new Esplora(API);
const feeRate = await api.feeRate();
let utxos: Utxo[] = await api.utxos(desk.address);
console.log(`desk holds ${fmtLit(utxos.reduce((t, u) => t + u.value, 0n))} LTC in ${utxos.length} coins · fee ${feeRate} lit/vB`);

for (const batch of batches) {
  try {
    const built = buildTx({
      network: NETWORK,
      secret,
      utxos,
      payments: batch.map((p) => ({ address: p.to, lit: BigInt(p.lit) })),
      memo: memo.paid(batch.map((p) => p.id)),
      feeRate,
    });
    const txid = await api.broadcast(built.hex);
    for (const p of batch) sent[p.id] = txid;
    writeFileSync(SENT, JSON.stringify(sent, null, 1));
    console.log(`paid ${batch.map((p) => `#${p.id}`).join(" ")} · ${fmtLit(built.fee)} LTC fee · ${txid}`);
    // spend the change of this transaction in the next one, not the coins it used
    const spent = new Set(built.inputs.map((u) => `${u.txid}:${u.vout}`));
    utxos = utxos.filter((u) => !spent.has(`${u.txid}:${u.vout}`));
    if (built.change > 0n) utxos.push({ txid, vout: built.outputs.length - 1, value: built.change, confirmed: false });
  } catch (e) {
    // not enough coins, explorer down, a rejected broadcast… leave it due and move on
    console.error(`FAIL ${batch.map((p) => `#${p.id}`).join(" ")}: ${(e as Error).message.split("\n")[0]}`);
  }
}
