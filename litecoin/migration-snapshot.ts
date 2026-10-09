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
//   node litecoin/migration-snapshot.ts --only LESTER      a partial run (rehearsals); the real migration takes every coin
//
// A holder who registered an EVM address on the ledger (`NOTUS1 evm 0x…`)
// gets their coins there; anyone else at the address their public key
// derives. A holder without a known public key (they only ever received
// coins by `send`, never spent from that address) cannot be minted to
// directly: their balance is listed under `unresolved`, and either goes to
// --vault for a later signed claim, or the run fails so nothing is silently
// dropped.
//
// The ledger must be frozen AND the freeze reached with margin: a snapshot
// of a ledger that can still change is not a snapshot (--allow-unfrozen is
// for dry runs only).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { evmAddressOfPubkey } from "../web/lib/litecoin/tx.ts";

/** Blocks the freeze must be behind the chain tip before a snapshot is taken from it. */
const FREEZE_MARGIN = 6;

const ROOT = import.meta.dirname;
const STATE = process.env.NOTUS_LTC_STATE ?? join(ROOT, "../web/public/litecoin/state.json");
const SCALE = 10n ** 10n; // 8 → 18 decimals
const TOTAL = 1_000_000_000n * 10n ** 18n;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const vault = flag("--vault");
/** --only LESTER,LCAT: a partial run (rehearsals on a testnet with little gas); the real migration takes every coin. */
const only = flag("--only")?.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
if (vault !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(vault)) throw new Error("--vault must be an EVM address");

type Snapshot = {
  network: string; height: number; chainTip?: number | null; stateRoot: string | null; freezeHeight: number | null; liabilitiesLit: string;
  coins: { ticker: string; name: string; logo: string; creator: string; feesToHolders: boolean; vLit: string; realLit: string; sold: string; graduated?: boolean; poolLit?: string; poolToken?: string }[];
  balances: Record<string, Record<string, string>>;
  pubkeys: Record<string, string>;
  evm?: Record<string, string>;
  claimable: Record<string, string>;
  payouts: { paidTxid: string | null; lit: string }[];
};
const s = JSON.parse(readFileSync(STATE, "utf8")) as Snapshot;
const dryRun = args.includes("--allow-unfrozen");
if (!dryRun) {
  if (s.freezeHeight === null) throw new Error("the ledger is not frozen (NOTUS_LTC_FREEZE unset): balances can still change. Freeze first, or pass --allow-unfrozen for a dry run");
  // the chain, not the ledger, says whether the freeze is reached: a quiet
  // ledger's height is the last block that carried an instruction
  if ((s.chainTip ?? s.height) < s.freezeHeight) throw new Error(`the freeze at block ${s.freezeHeight} is not reached: the chain is at ${s.chainTip ?? s.height} and the ledger can still change`);
  const tip = s.chainTip ?? s.height;
  if (tip - s.freezeHeight < FREEZE_MARGIN) throw new Error(`the freeze at block ${s.freezeHeight} is only ${tip - s.freezeHeight} block(s) deep (tip ${tip}): wait for ${FREEZE_MARGIN}, a reorg could still change it`);
}

/** A holder's EVM address: the one they registered on the ledger, else the one their public key derives. */
const evm = (ltcAddress: string) => s.evm?.[ltcAddress] ?? (s.pubkeys[ltcAddress] ? evmAddressOfPubkey(s.pubkeys[ltcAddress]) : null);
const unresolved: { ticker: string; address: string; balance: string }[] = [];
let bridgeWei = 0n;

const picked = only ? s.coins.filter((c) => only.includes(c.ticker)) : s.coins;
if (only && picked.length !== only.length) throw new Error(`--only: unknown ticker(s) ${only.filter((t) => !picked.some((c) => c.ticker === t)).join(", ")}`);
const coins = picked.map((c) => {
  // a creator who signed from a script type whose key we cannot read (taproot, multisig) has no
  // derived address; their creator fees on LitVM then accrue to the vault until a signed claim
  const creator = evm(c.creator) ?? vault;
  if (!creator) throw new Error(`${c.ticker}: the creator ${c.creator} has no public key on record (a script type without a readable key): pass --vault, or have them register with \`NOTUS1 evm 0x…\``);
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
  // a graduated coin migrates its pool: the reserve that goes to the DEX and the LTC in it
  const poolToken = c.graduated ? BigInt(c.poolToken ?? "0") * SCALE : 0n;
  const sold = c.graduated ? TOTAL - poolToken : BigInt(c.sold) * SCALE;
  const delivered = balances.reduce((t, b) => t + b, 0n);
  if (delivered !== sold - (vault ? 0n : vaulted)) throw new Error(`${c.ticker}: balances (${delivered}) do not add up to what holders own (${sold})`);
  const realQuote = (c.graduated ? BigInt(c.poolLit ?? "0") : BigInt(c.realLit)) * SCALE;
  bridgeWei += realQuote;
  return {
    name: c.name,
    symbol: c.ticker,
    logo: c.logo,
    website: "",
    twitter: "",
    telegram: "",
    livestream: "",
    description: "Migrated from Notus on Litecoin",
    creator,
    feeRecipient: "0x0000000000000000000000000000000000000000",
    // the ledger knew one choice: the whole pot to holders or to the creator, no tax, no burn, no pots
    buyTaxBps: 0n,
    sellTaxBps: 0n,
    creatorBps: c.feesToHolders ? 0n : 10_000n,
    holdersBps: c.feesToHolders ? 10_000n : 0n,
    burnBps: 0n,
    liquidityBps: 0n,
    virtualQuote: (BigInt(c.vLit) - BigInt(c.realLit)) * SCALE,
    realQuote,
    sold,
    burned: 0n,
    poolToken,
    burnPot: 0n,
    liquidityPot: 0n,
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
// what all the curves and pools hold, whether or not this run picks them: the rest is settled on Litecoin
const inCurves = s.coins.reduce((t, c) => t + BigInt(c.graduated ? c.poolLit ?? "0" : c.realLit), 0n);

const out = {
  network: s.network,
  height: s.height,
  freezeHeight: s.freezeHeight ?? s.height,
  stateRoot: s.stateRoot,
  partial: !!only,
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
// uint256 fields must be JSON numbers for vm.parseJson: bigints are tagged with a
// one-off marker no coin name can contain, then the quotes around them removed
const tag = `__big_${randomBytes(8).toString("hex")}_`;
const json = JSON.stringify(out, (_, v) => (typeof v === "bigint" ? `${tag}${v}` : v), 1).replace(new RegExp(`"${tag}(\\d+)"`, "g"), "$1");
const outFile = flag("--out") ?? join(ROOT, "migration", `${s.network}-${s.freezeHeight ?? s.height}.json`);
mkdirSync(join(outFile, ".."), { recursive: true });
writeFileSync(outFile, json);
console.log(`${outFile}: ${coins.length} coins, ${out.totals.holders} holders, bridge ${out.totals.bridgeLtc} LTC, settle ${(Number(out.totals.settleOnLitecoinLit) / 1e8).toFixed(8)} LTC on Litecoin${unresolved.length ? `, ${unresolved.length} unresolved → ${vault}` : ""}`);
