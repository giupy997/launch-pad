// Notus on Zcash — a command-line user, for end-to-end testing: it does from
// a devtool wallet exactly what the website asks a person to do from theirs
// (a shielded payment to the desk with the right memo).
//
//   node zcash/user.ts deploy CAT "Zcash Cat" h [extraZecForDevBuy]
//   node zcash/user.ts buy CAT 0.05
//   node zcash/user.ts sell CAT 50        (percent of the balance)
//   node zcash/user.ts claim
//   node zcash/user.ts whoami
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PARAMS, memo, newHolderKey, quoteSell } from "../web/lib/zcash/ledger.ts";

const ROOT = import.meta.dirname;
const TOOL = join(ROOT, "tool/target/release/zcash-devtool");
const WALLET = process.env.NOTUS_ZCASH_USER ?? join(ROOT, "user");
const STATE = join(ROOT, "../web/public/zcash/state.json");
const DUST = 1_000n;

const keyFile = join(WALLET, "holder.json");
if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify(newHolderKey(), null, 1));
const key = JSON.parse(readFileSync(keyFile, "utf8")) as { secret: string; holder: string };
const state = JSON.parse(readFileSync(STATE, "utf8"));
const desk: string = state.desk.address;
const myAddress = () => /Default Address:\s+(\S+)/.exec(execFileSync(TOOL, ["wallet", "-w", WALLET, "list-addresses"], { encoding: "utf8" }))![1];
const nextNonce = () => BigInt(state.nonces[key.holder] ?? 0) + 1n;
const zat = (zec: string) => BigInt(Math.round(Number(zec) * 1e8));

function pay(valueZat: bigint, memoText: string) {
  if (new TextEncoder().encode(memoText).length > 512) throw new Error("memo over 512 bytes");
  console.log(`-> ${(Number(valueZat) / 1e8).toFixed(8)} ZEC · ${memoText.slice(0, 90)}${memoText.length > 90 ? "…" : ""}`);
  const out = execFileSync(
    TOOL,
    ["wallet", "-w", WALLET, "send", "-i", join(WALLET, "identity.txt"), "--address", desk, "--value", valueZat.toString(), "--memo", memoText],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  console.log(/[0-9a-f]{64}/.exec(out)?.[0] ?? out.trim().split("\n").at(-1));
}

const [cmd, a, b, c, d] = process.argv.slice(2);
if (cmd === "whoami") {
  console.log("holder key:", key.holder, "\naddress:   ", myAddress());
} else if (cmd === "deploy") {
  pay(PARAMS.test.deployFeeZat + (d ? zat(d) : 0n), memo.deploy(a, b, key.holder, c === "h"));
} else if (cmd === "buy") {
  pay(zat(b), memo.buy(a, key.holder));
} else if (cmd === "sell") {
  const bal = BigInt(state.balances[a]?.[key.holder] ?? 0);
  const amount = (bal * BigInt(b)) / 100n;
  const coin = state.coins.find((x: { ticker: string }) => x.ticker === a);
  const q = quoteSell({ vZat: BigInt(coin.vZat), vToken: BigInt(coin.vToken), realZat: BigInt(coin.realZat) }, amount);
  pay(DUST, memo.sell(key.secret, "test", a, amount, (q.net * 97n) / 100n, myAddress(), nextNonce()));
} else if (cmd === "claim") {
  pay(DUST, memo.claim(key.secret, "test", myAddress(), nextNonce()));
} else {
  console.log("usage: deploy TICKER NAME c|h [devBuyZec] | buy TICKER zec | sell TICKER percent | claim | whoami");
}
