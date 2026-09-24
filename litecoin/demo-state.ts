// Writes a DEMO snapshot — synthetic transactions run through the real
// ledger — so the Litecoin pages can be looked at before the testnet desk has
// any activity. `node litecoin/indexer.ts` overwrites it with the chain state.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PARAMS, memo, replay, snapshot, type TxEvent } from "../web/lib/litecoin/ledger.ts";
import { CARRY_LIT, newSecret, walletFromSecret } from "../web/lib/litecoin/tx.ts";

const OUT = join(import.meta.dirname, "../web/public/litecoin/state.json");
const DESK = walletFromSecret(newSecret(), "test").address;
const people = Array.from({ length: 6 }, () => walletFromSecret(newSecret(), "test").address);
const events: TxEvent[] = [];
let h = 3_600_000;
const ev = (sender: string, m: string, lit: bigint) =>
  events.push({
    height: (h += 1 + (events.length % 3)), txIndex: 1 + (events.length % 5), txid: (events.length + 1).toString(16).padStart(64, "0"),
    time: 1_789_990_000 + events.length * 150, sender, valueLit: lit, memo: m, fromDesk: false,
    outputs: [{ address: DESK, lit, toDesk: true }, { address: null, lit: 0n, toDesk: false }, { address: sender, lit: 50_000n, toDesk: false }],
  });

ev(people[0], memo.deploy("LCAT", "Lite Cat", true, "https://i.imgur.com/1Q9Z1Zm.png"), PARAMS.test.deployFeeLit + 2_000_000n);
ev(people[1], memo.deploy("CHIKUN", "Chikun", false), PARAMS.test.deployFeeLit);
ev(people[2], memo.deploy("MWEB", "Mimble", true), PARAMS.test.deployFeeLit + 500_000n);
let seed = 7;
const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
for (let i = 0; i < 40; i++) {
  const who = people[rnd(6)], t = ["LCAT", "LCAT", "CHIKUN", "MWEB"][rnd(4)];
  const s = replay("test", events);
  const bal = s.balances.get(t)?.get(who) ?? 0n;
  if (bal > 0n && rnd(3) === 0) ev(who, memo.sell(t, bal / 3n, 0n), CARRY_LIT);
  else ev(who, memo.buy(t), BigInt(500_000 + rnd(9_000_000)));
}
const state = replay("test", events);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ ...snapshot(state), desk: { address: DESK, network: "test" }, chainTip: state.height + 2, confirmations: 2, updatedAt: Math.floor(Date.now() / 1000), demo: true }, null, 1)
);
console.log(`demo snapshot: ${state.coins.size} coins, ${state.trades.length} trades, ${state.payouts.length} payouts`);
console.log("demo holder address (its balances show on /litecoin/c/LCAT):", people[0]);
