// Notus on Zcash — the indexer.
//
// Syncs the desk wallet, reads every memo its viewing key can see straight
// out of the wallet database, replays the ledger rules over them and writes
// the snapshot the website serves. Anyone can run the same thing with only
// the published viewing key (`init-fvk`) and must get the same state root.
//
//   node zcash/indexer.ts            one pass
//   node zcash/indexer.ts --watch    keep going, every 30s
//   node zcash/indexer.ts --no-sync  replay the local database only
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { replay, snapshot, type MemoEvent, type Network } from "../web/lib/zcash/ledger.ts";

const ROOT = import.meta.dirname;
const TOOL = join(ROOT, "tool/target/release/zcash-devtool");
const WALLET = process.env.NOTUS_ZCASH_WALLET ?? join(ROOT, "desk");
const OUT = process.env.NOTUS_ZCASH_STATE ?? join(ROOT, "../web/public/zcash/state.json");
const NETWORK: Network = process.env.NOTUS_ZCASH_NETWORK === "main" ? "main" : "test";
/** Memos fold into the ledger once this deep, so a reorg cannot unwind them. */
const CONFIRMATIONS = 2;

function tool(...args: string[]): string {
  return execFileSync(TOOL, ["wallet", "-w", WALLET, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A text memo is UTF-8 padded with zeros; first byte above 0xF4 means "not text". */
function memoText(raw: Uint8Array | null): string | null {
  if (!raw || raw.length === 0 || raw[0] > 0xf4) return null;
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, end));
  } catch {
    return null;
  }
}

/** Zcash shows txids byte-reversed from how they are stored. */
const txidHex = (raw: Uint8Array) => Buffer.from(raw).reverse().toString("hex");

export function readEvents(walletDir: string, maxHeight: number): MemoEvent[] {
  const db = new DatabaseSync(join(walletDir, "data.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT o.txid, o.tx_mined_height AS height, t.tx_index AS txIndex, t.block_time AS time,
                o.output_pool AS pool, o.output_index AS outputIndex, o.value, o.memo,
                o.from_account_uuid AS fromAcct, o.to_account_uuid AS toAcct
           FROM v_tx_outputs o JOIN v_transactions t ON t.txid = o.txid
          WHERE o.tx_mined_height IS NOT NULL AND o.tx_mined_height <= ? AND o.memo IS NOT NULL
            AND COALESCE(o.is_change, 0) = 0`
      )
      .all(maxHeight) as Record<string, unknown>[];
    const events: MemoEvent[] = [];
    for (const r of rows) {
      const memo = memoText(r.memo as Uint8Array | null);
      const received = r.toAcct !== null && r.fromAcct === null;
      const sent = r.fromAcct !== null && r.toAcct === null;
      if (memo === null || (!received && !sent)) continue; // self-sends carry no instruction
      events.push({
        height: Number(r.height),
        txIndex: Number(r.txIndex ?? 0),
        // pools have separate output numbering: keep the order stable across them
        outputIndex: Number(r.pool) * 10_000 + Number(r.outputIndex),
        txid: txidHex(r.txid as Uint8Array),
        time: Number(r.time ?? 0),
        valueZat: BigInt(r.value as number | bigint),
        memo,
        fromDesk: sent,
      });
    }
    return events;
  } finally {
    db.close();
  }
}

function pass(sync: boolean) {
  let tip = 0;
  if (sync) {
    tool("sync");
    tool("enhance"); // memos live in the full transactions, not in compact blocks
    tip = JSON.parse(tool("get-info").trim().split("\n").at(-1)!).chain_tip_height;
  } else {
    tip = Number.MAX_SAFE_INTEGER;
  }
  const events = readEvents(WALLET, tip - (CONFIRMATIONS - 1));
  const state = replay(NETWORK, events);
  const accounts = tool("list-accounts");
  const out = {
    ...snapshot(state),
    desk: {
      address: /Default Address:\s+(\S+)/.exec(tool("list-addresses"))?.[1] ?? null,
      ufvk: /UFVK:\s+(\S+)/.exec(accounts)?.[1] ?? null,
      // a verifier's view-only wallet must scan from here to see every memo
      birthday: Number(/birthday height (\d+)/.exec(accounts)?.[1] ?? 0),
    },
    chainTip: sync ? tip : null,
    confirmations: CONFIRMATIONS,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(out, null, 1);
  let changed = true;
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf8"));
    changed = prev.stateRoot !== out.stateRoot || prev.chainTip !== out.chainTip;
  } catch {}
  writeFileSync(OUT, json);
  if (changed) {
    console.log(
      `[${new Date().toISOString()}] tip ${sync ? tip : "local"} · ${events.length} memos · ${state.coins.size} coins · ` +
        `${state.payouts.filter((p) => !p.paidTxid).length} payouts due · root ${out.stateRoot?.slice(0, 16) ?? "-"}`
    );
  }
}

if (process.argv[1] === import.meta.filename) {
  const sync = !process.argv.includes("--no-sync");
  pass(sync);
  if (process.argv.includes("--watch")) {
    setInterval(() => {
      try {
        pass(sync);
      } catch (e) {
        console.error("pass failed:", (e as Error).message.split("\n")[0]);
      }
    }, 30_000);
  }
}
