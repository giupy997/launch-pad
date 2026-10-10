// Notus on Zcash — the desk's spend path.
//
// Sends every payout the ledger says is due (sell proceeds and claims), each
// carrying the memo `NOTUS1 paid <id>` so the payment itself is what marks it
// settled when the indexer next replays the chain.
//
//   node zcash/payout.ts            pay what is due
//   node zcash/payout.ts --dry-run  only list it
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memo } from "../web/lib/zcash/ledger.ts";

const ROOT = import.meta.dirname;
const TOOL = join(ROOT, "tool/target/release/zcash-devtool");
const WALLET = process.env.NOTUS_ZCASH_WALLET ?? join(ROOT, "desk");
const STATE = process.env.NOTUS_ZCASH_STATE ?? join(ROOT, "../web/public/zcash/state.json");
// A payout stays "due" in the ledger until its payment is mined and folded
// in, so remember what was already broadcast or it would be paid twice.
const SENT = join(WALLET, "sent-payouts.json");

type Payout = { id: number; kind: string; to: string; zat: string; paidTxid: string | null };

const dryRun = process.argv.includes("--dry-run");
const state = JSON.parse(readFileSync(STATE, "utf8")) as { payouts: Payout[] };
const sent: Record<string, string> = existsSync(SENT) ? JSON.parse(readFileSync(SENT, "utf8")) : {};
const due = state.payouts.filter((p) => !p.paidTxid && !(p.id in sent));

if (due.length === 0) console.log("nothing due");
for (const p of due) {
  const zec = (Number(p.zat) / 1e8).toFixed(8);
  if (dryRun) {
    console.log(`due  #${p.id} ${p.kind} ${zec} ZEC -> ${p.to.slice(0, 24)}…`);
    continue;
  }
  try {
    const out = execFileSync(
      TOOL,
      ["wallet", "-w", WALLET, "send", "-i", join(WALLET, "identity.txt"), "--address", p.to, "--value", p.zat, "--memo", memo.paid(p.id)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const txid = /[0-9a-f]{64}/.exec(out)?.[0] ?? "broadcast";
    sent[p.id] = txid;
    writeFileSync(SENT, JSON.stringify(sent, null, 1));
    console.log(`paid #${p.id} ${p.kind} ${zec} ZEC -> ${p.to.slice(0, 24)}… ${txid}`);
  } catch (e) {
    // not enough spendable notes yet, bad address… leave it due and move on
    console.error(`FAIL #${p.id}: ${((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split("\n").at(-1)}`);
  }
}
