// Notus on Litecoin — make a wallet key for the desk or for a test user.
//
//   node litecoin/keygen.ts desk     writes litecoin/desk/key.json (once) and prints the address
//   node litecoin/keygen.ts user     same for the CLI test user
//
// The key file is the only copy of the secret: back it up. Both directories
// are gitignored. NOTUS_LTC_NETWORK=main derives mainnet addresses.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newSecret, walletFromSecret } from "../web/lib/litecoin/tx.ts";
import type { Network } from "../web/lib/litecoin/ledger.ts";

const NETWORK: Network = process.env.NOTUS_LTC_NETWORK === "main" ? "main" : "test";
const who = process.argv[2];
if (who !== "desk" && who !== "user") {
  console.log("usage: node litecoin/keygen.ts desk|user");
  process.exit(1);
}
const dir = join(import.meta.dirname, who);
const file = join(dir, "key.json");
if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ secret: newSecret() }, null, 1), { mode: 0o600 });
  console.log(`new key written to ${file} — back it up`);
}
const w = walletFromSecret(JSON.parse(readFileSync(file, "utf8")).secret, NETWORK);
console.log(`${who} address (${NETWORK}net): ${w.address}`);
console.log(`WIF (import into Electrum-LTC as p2wpkh:${w.wif.slice(0, 6)}…): ${w.wif}`);
