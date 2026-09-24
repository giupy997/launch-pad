// Notus on Litecoin → LitVM: the migration file.
//
// Turns a (frozen) ledger snapshot into what MigrateFromLedger.s.sol needs
// to re-create every coin on the EVM Launchpad: curve state, creator and
// holders as EVM addresses, balances. Litecoin and EVM chains share
// secp256k1, so a holder's public key — revealed by their own transactions
// to the desk — is their EVM address too. Amounts are scaled from 8 to 18
// decimals (litoshi → wei of zkLTC, coin units → 1e18 tokens).
//
//   node litecoin/migration-snapshot.ts                    from web/public/litecoin/state.json
//   node litecoin/migration-snapshot.ts --vault 0x...      unresolved holders' coins go to this address
//   node litecoin/migration-snapshot.ts --allow-unfrozen   for a dry run on a live ledger
//
// A holder without a known public key (they only ever received coins by
// `send`, never spent from that address) cannot be minted to directly: their
// balance is listed under `unresolved`, and either goes to --vault for a
// later signed claim, or the run fails so nothing is silently dropped.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evmAddressOfPubkey } from "../web/lib/litecoin/tx.ts";

const ROOT = import.meta.dirname;
const STATE = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");
const SCALE = 10n ** 10n; // 8 → 18 decimals

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const vault = flag("--vault");
if (vault !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error("--vault must be an EVM address");

type Snapshot = {
  network: string; height: number; stateRoot: string | null; freezeHeight: number | null; liabilitiesLit: string;
  coins: { ticker: string; name: string; logo: string; creator: string; feesToHolders: boolean; vLit: string; realLit: string; sold: string }[];
  balances: Record<string, Record<string, string>>;
  pubkeys: Record<string, string>;
  claimable: Record<string, string>;
  payouts: { paidTxid: string | null; lit: string }[];
};
const s = JSON.parse(readFileSync(STATE, "utf8")) as Snapshot;
if (s.freezeHeight === null && !args.includes("--allow-unfrozen")) {
  throw new Error("the ledger is not frozen (NOTUS_LTC_FREEZE unset): balances can still change. Freeze first, or pass --allow-unfrozen for a dry run");
}

const evm = (ltcAddress: string) => (s.pubkeys[ltcAddress] ? evmAddressOfPubkey(s.pubkeys[ltcAddress]) : null);
const unresolved: { ticker: string; address: string; balance: string }[] = [];
let bridgeWei = 0n;

const coins = s.coins.map((c) => {
  const creator = evm(c.creator);
  if (!creator) throw new Error(`${c.ticker}: the creator ${c.creator} has no public key on record — impossible, the deploy was signed`);
  const holders: string[] = [];
  const balances: bigint[] = [];
  let vaulted = 0n;
  for (const [address, bal] of Object.entries(s.balances[c.ticker] ?? {}).sort()) {
    const units = BigInt(bal) * SCALE;
    if (units === 0n) continue;
    const to = evm(address);
    if (to) {
      holders.push(to);
      balances.push(units);
    } else {
      unresolved.push({ ticker: c.ticker, address, balance: bal });
      vaulted += units;
    }
  }
  if (vaulted > 0n && vault) {
    holders.push(vault);
    balances.push(vaulted);
  }
  const sold = BigInt(c.sold) * SCALE;
  const delivered = balances.reduce((t, b) => t + b, 0n);
  if (delivered !== sold - (vault ? 0n : vaulted)) throw new Error(`${c.ticker}: balances (${delivered}) do not add up to sold (${sold})`);
  const realQuote = BigInt(c.realLit) * SCALE;
  bridgeWei += realQuote;
  return {
    name: c.name,
    symbol: c.ticker,
    logo: c.logo,
    creator,
    feesToHolders: c.feesToHolders,
    virtualQuote: (BigInt(c.vLit) - BigInt(c.realLit)) * SCALE,
    realQuote,
    sold,
    holders,
    balances,
  };
});

if (unresolved.length && !vault) {
  for (const u of unresolved) console.error(`unresolved: ${u.ticker} ${u.address} ${u.balance}`);
  throw new Error(`${unresolved.length} holder balance(s) have no public key: pass --vault <address> to park them for a signed claim`);
}

// what stays the desk's job on Litecoin: claims and payouts, settled there
let dueLit = 0n;
for (const v of Object.values(s.claimable)) dueLit += BigInt(v);
for (const p of s.payouts) if (!p.paidTxid) dueLit += BigInt(p.lit);
// pending holder cashback is inside liabilities but not in `claimable` totals per coin; report the ledger's own number
const liabilities = BigInt(s.liabilitiesLit);
const inCurves = coins.reduce((t, c) => t + c.realQuote / SCALE, 0n);

const out = {
  network: s.network,
  height: s.height,
  freezeHeight: s.freezeHeight,
  stateRoot: s.stateRoot,
  generatedAt: new Date().toISOString(),
  totals: {
    coins: coins.length,
    holders: coins.reduce((t, c) => t + c.holders.length, 0),
    bridgeWei: bridgeWei.toString(),
    bridgeLtc: (Number(bridgeWei / SCALE) / 1e8).toFixed(8),
    settleOnLitecoinLit: (liabilities - inCurves).toString(),
    unresolved: unresolved.length,
    vault: vault ?? null,
  },
  unresolved,
  coins,
};
// uint256 fields must be JSON numbers for vm.parseJson: stringify bigints raw
const json = JSON.stringify(out, (_, v) => (typeof v === "bigint" ? `__big__${v}` : v), 1).replace(/"__big__(\d+)"/g, "$1");
const outFile = flag("--out") ?? join(ROOT, "migration", `${s.network}-${s.freezeHeight ?? s.height}.json`);
mkdirSync(join(outFile, ".."), { recursive: true });
writeFileSync(outFile, json);
console.log(`${outFile}: ${coins.length} coins, ${out.totals.holders} holders, bridge ${out.totals.bridgeLtc} LTC, settle ${(Number(out.totals.settleOnLitecoinLit) / 1e8).toFixed(8)} LTC on Litecoin${unresolved.length ? `, ${unresolved.length} unresolved → ${vault}` : ""}`);
