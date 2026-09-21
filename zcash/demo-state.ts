// Writes a DEMO snapshot — synthetic memos run through the real ledger — so
// the Zcash pages can be looked at before the testnet desk has any activity.
// `node zcash/indexer.ts` overwrites it with the real chain state.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARAMS, memo, newHolderKey, replay, snapshot, type MemoEvent } from "../web/lib/zcash/ledger.ts";

const OUT = join(import.meta.dirname, "../web/public/zcash/state.json");
const ADDR = "utest1" + "demo".repeat(20);
const keys = Array.from({ length: 6 }, newHolderKey);
const events: MemoEvent[] = [];
let h = 4_374_600;
const ev = (m: string, zat: bigint) =>
  events.push({ height: (h += 1 + (events.length % 3)), txIndex: 1, outputIndex: 0, txid: (events.length + 1).toString(16).padStart(64, "0"), time: 1_789_990_000 + events.length * 150, valueZat: zat, memo: m, fromDesk: false });

ev(memo.deploy("ZCAT", "Zcash Cat", keys[0].holder, true), PARAMS.test.deployFeeZat + 2_000_000n);
ev(memo.deploy("SHIELD", "Shielded Summer", keys[1].holder, false), PARAMS.test.deployFeeZat);
ev(memo.deploy("ORCHARD", "Orchard", keys[2].holder, true), PARAMS.test.deployFeeZat + 500_000n);
let seed = 7;
const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
for (let i = 0; i < 40; i++) {
  const k = keys[rnd(6)], t = ["ZCAT", "ZCAT", "SHIELD", "ORCHARD"][rnd(4)];
  const s = replay("test", events);
  const bal = s.balances.get(t)?.get(k.holder) ?? 0n;
  if (bal > 0n && rnd(3) === 0) ev(memo.sell(k.secret, "test", t, bal / 3n, 0n, ADDR, (s.nonces.get(k.holder) ?? 0n) + 1n), 1_000n);
  else ev(memo.buy(t, k.holder), BigInt(500_000 + rnd(9_000_000)));
}
const state = replay("test", events);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ ...snapshot(state), desk: { address: ADDR, ufvk: "uviewtest1demo" }, chainTip: state.height + 2, confirmations: 2, updatedAt: Math.floor(Date.now() / 1000), demo: true }, null, 1));
console.log(`demo snapshot: ${state.coins.size} coins, ${state.trades.length} trades, ${state.payouts.length} payouts`);
console.log("demo holder secret (paste in /zcash/wallet to see balances):", keys[0].secret);
