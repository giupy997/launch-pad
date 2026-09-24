// Notus on Litecoin — a command-line user, for end-to-end testing: it does
// from a key file exactly what the website does from the browser wallet.
//
//   node litecoin/user.ts whoami                       address to fund from a faucet
//   node litecoin/user.ts balance
//   node litecoin/user.ts deploy CAT "Lite Cat" h [devBuyLtc] [logoUrl]
//   node litecoin/user.ts buy CAT 0.05
//   node litecoin/user.ts sell CAT 50                  percent of the balance
//   node litecoin/user.ts send CAT 25 <address>        percent, to a Litecoin address
//   node litecoin/user.ts claim
//   node litecoin/user.ts withdraw <address> 0.1       plain LTC out of the test wallet
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARAMS, memo, memoBytes, quoteSell, type Network } from "../web/lib/litecoin/ledger.ts";
import { Esplora, PUBLIC_API, PUBLIC_EXPLORER } from "../web/lib/litecoin/esplora.ts";
import { CARRY_LIT, DUST_LIT, buildTx, fmtLit, walletFromSecret, type Payment } from "../web/lib/litecoin/tx.ts";

const ROOT = import.meta.dirname;
const NETWORK: Network = process.env.NOTUS_LTC_NETWORK === "main" ? "main" : "test";
const API = process.env.NOTUS_LTC_API ?? PUBLIC_API[NETWORK];
const STATE = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");

const secret: string = JSON.parse(readFileSync(join(ROOT, "user/key.json"), "utf8")).secret;
const me = walletFromSecret(secret, NETWORK);
const api = new Esplora(API);
const lit = (ltc: string) => BigInt(Math.round(Number(ltc) * 1e8));

async function send(payments: Payment[], memoText: string | null) {
  if (memoText && memoBytes(memoText) > 80) throw new Error("memo over 80 bytes");
  const built = buildTx({ network: NETWORK, secret, utxos: await api.utxos(me.address), payments, memo: memoText, feeRate: await api.feeRate() });
  console.log(`-> ${payments.map((p) => `${fmtLit(p.lit)} LTC to ${p.address.slice(0, 12)}…`).join(", ")} · fee ${fmtLit(built.fee)} · ${memoText ?? "(no memo)"}`);
  const txid = await api.broadcast(built.hex);
  console.log(`${PUBLIC_EXPLORER[NETWORK]}/tx/${txid}`);
}

const state = () => JSON.parse(readFileSync(STATE, "utf8"));
const desk = (): string => state().desk.address;
const [cmd, a, b, c, d, e] = process.argv.slice(2);

if (cmd === "whoami") {
  console.log("address:", me.address);
} else if (cmd === "balance") {
  const utxos = await api.utxos(me.address);
  console.log(`${fmtLit(utxos.reduce((t, u) => t + u.value, 0n))} LTC in ${utxos.length} coins`);
  const s = state();
  for (const coin of s.coins) {
    const bal = s.balances[coin.ticker]?.[me.address];
    if (bal) console.log(`${coin.ticker}: ${(Number(bal) / 1e8).toLocaleString("en-US")} coins`);
  }
  console.log(`claimable: ${fmtLit(BigInt(s.claimable[me.address] ?? 0))} LTC`);
} else if (cmd === "deploy") {
  await send([{ address: desk(), lit: PARAMS[NETWORK].deployFeeLit + (d ? lit(d) : 0n) }], memo.deploy(a, b, c === "h", e ?? ""));
} else if (cmd === "buy") {
  await send([{ address: desk(), lit: lit(b) }], memo.buy(a));
} else if (cmd === "sell") {
  const s = state();
  const bal = BigInt(s.balances[a]?.[me.address] ?? 0);
  const amount = (bal * BigInt(b)) / 100n;
  const coin = s.coins.find((x: { ticker: string }) => x.ticker === a);
  const q = quoteSell({ vLit: BigInt(coin.vLit), vToken: BigInt(coin.vToken), realLit: BigInt(coin.realLit) }, amount);
  await send([{ address: desk(), lit: CARRY_LIT }], memo.sell(a, amount, (q.net * 97n) / 100n));
} else if (cmd === "send") {
  const bal = BigInt(state().balances[a]?.[me.address] ?? 0);
  // output 0 pays the desk, 1 is the memo, 2 is the recipient
  await send([{ address: desk(), lit: CARRY_LIT }, { address: c, lit: DUST_LIT }], memo.send(a, (bal * BigInt(b)) / 100n, 2));
} else if (cmd === "claim") {
  await send([{ address: desk(), lit: CARRY_LIT }], memo.claim());
} else if (cmd === "withdraw") {
  await send([{ address: a, lit: lit(b) }], null);
} else {
  console.log("usage: whoami | balance | deploy TICKER NAME c|h [devBuyLtc] [logoUrl] | buy TICKER ltc | sell TICKER percent | send TICKER percent address | claim | withdraw address ltc");
}
