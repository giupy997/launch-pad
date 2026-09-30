// The migration file of an EVM launchpad, frozen for a move to another chain
// (Base → LitVM). Reads every coin at the freeze block — its curve, its
// metadata, who holds what (from the token's Transfer logs, checked against
// balanceOf), and for a graduated coin its pool's two sides — and writes the
// same file litecoin/migration-snapshot.ts writes for the Litecoin ledger, so
// MigrateFromLedger.s.sol re-creates the coins on the other side unchanged.
// Quote amounts are scaled to 18 decimals (cbLTC has 8; zkLTC is native).
//
//   node script/snapshot-evm.mjs --rpc https://mainnet.base.org --launchpad 0x... \
//     --quote 0xcb17C9Db87B595717C857a08468793f5bAb6445F --from-block <pad deploy block> \
//     [--network base] [--out ../litecoin/migration/base-<block>.json] [--chunk 5000] [--allow-unfrozen] [--vault 0x...]
//
// Refuses a launchpad that is not frozen (the balances could still change)
// unless --allow-unfrozen, for a dry run at the latest block. A graduated
// coin whose pool holds liquidity besides the migrator's leaves those
// providers' coins in the pool on this chain: the receiving side needs
// holders + pool == supply, so those coins go to --vault (an address of
// yours, for a claim by hand) or the run refuses. Needs `forge build` (the
// ABIs come from out/) and web/'s node_modules (viem).
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, http, keccak256, toHex, getAddress, parseAbiItem } from "../../web/node_modules/viem/_esm/index.js";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const need = (name) => {
  const v = flag(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
};

const rpc = need("rpc");
const launchpad = getAddress(need("launchpad"));
const quoteAsset = getAddress(need("quote"));
const fromBlock = BigInt(need("from-block"));
const network = flag("network", "base");
const chunkDefault = BigInt(flag("chunk", "5000"));
const allowUnfrozen = args.includes("--allow-unfrozen");
const vault = flag("vault") ? getAddress(flag("vault")) : null;

const abi = (file, name) => JSON.parse(fs.readFileSync(path.join(root, "out", file, `${name}.json`), "utf8")).abi;
const padAbi = abi("Launchpad.sol", "Launchpad");
const tokenAbi = abi("LaunchToken.sol", "LaunchToken");
const migratorAbi = abi("UniV2Migrator.sol", "UniV2Migrator");
const pairAbi = [
  parseAbiItem("function token0() view returns (address)"),
  parseAbiItem("function totalSupply() view returns (uint256)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
];
const erc20Abi = [
  parseAbiItem("function decimals() view returns (uint8)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
];
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
const read = (address, abi_, functionName, args_ = [], blockNumber) => client.readContract({ address, abi: abi_, functionName, args: args_, blockNumber });

// ---- the block: the freeze, reached
const freezeBlock = await read(launchpad, padAbi, "freezeBlock");
const latest = await client.getBlockNumber();
let block;
if (freezeBlock !== 0n && latest >= freezeBlock) block = freezeBlock;
else if (allowUnfrozen) block = latest;
else throw new Error(freezeBlock === 0n ? "the launchpad is not frozen: no freeze announced (balances can still change; --allow-unfrozen for a dry run)" : `the freeze at block ${freezeBlock} is not reached (chain at ${latest})`);
console.log(`chain ${chainId} · launchpad ${launchpad} · snapshot at block ${block}${block === freezeBlock ? " (the freeze)" : " (UNFROZEN dry run)"}`);

const quoteDecimals = BigInt(await read(quoteAsset, erc20Abi, "decimals"));
const SCALE = 10n ** (18n - quoteDecimals);
const TOTAL_SUPPLY = await read(launchpad, padAbi, "TOTAL_SUPPLY");
const DEX_RESERVE = await read(launchpad, padAbi, "DEX_RESERVE");
const treasury = await read(launchpad, padAbi, "treasury", [], block);

// ---- every coin
const count = await read(launchpad, padAbi, "tokenCount", [], block);
const tokens = [];
for (let i = 0n; i < count; i++) tokens.push(await read(launchpad, padAbi, "allTokens", [i], block));
console.log(`${tokens.length} coins`);

/** Transfer logs in chunks, halving the chunk on an RPC error. */
async function transfers(token) {
  const out = [];
  let from = fromBlock;
  let chunk = chunkDefault;
  while (from <= block) {
    const to = from + chunk - 1n > block ? block : from + chunk - 1n;
    try {
      const logs = await client.getLogs({ address: token, event: TRANSFER, fromBlock: from, toBlock: to });
      out.push(...logs);
      from = to + 1n;
    } catch (e) {
      if (chunk <= 100n) throw e;
      chunk /= 2n;
    }
  }
  return out;
}

const coins = [];
const sourceTokens = {};
const warnings = [];
let bridgeWei = 0n;
for (const token of tokens) {
  const [vEth, vToken, realEth, sold, graduated, creator, coinQuote] = await read(launchpad, padAbi, "curves", [token], block);
  const symbol = await read(token, tokenAbi, "symbol", [], block);
  const name = await read(token, tokenAbi, "name", [], block);
  if (getAddress(coinQuote) !== quoteAsset) {
    warnings.push(`${symbol}: quoted in ${coinQuote}, not the migrating quote asset — left out`);
    continue;
  }
  const meta = await read(launchpad, padAbi, "tokenMetadata", [token], block);
  const feesToHolders = await read(launchpad, padAbi, "feesToHolders", [token], block);
  if ((await read(launchpad, padAbi, "migrationPending", [token], block)) !== 0n) throw new Error(`${symbol}: a migrated coin still delivering its holders cannot migrate again yet`);

  // holders: fold the transfers, then trust only balanceOf at the block
  const balances = new Map();
  for (const log of await transfers(token)) {
    const { from, to, value } = log.args;
    if (from !== "0x0000000000000000000000000000000000000000") balances.set(from, (balances.get(from) ?? 0n) - value);
    balances.set(to, (balances.get(to) ?? 0n) + value);
  }
  let pair = null;
  let poolToken = 0n;
  let stranded = 0n; // coins in the pool that belong to other liquidity providers
  let realQuote = realEth * SCALE;
  if (graduated) {
    const via = await read(launchpad, padAbi, "graduatedVia", [token], block);
    if (via !== "0x0000000000000000000000000000000000000000") {
      pair = getAddress(await read(via, migratorAbi, "pairOf", [token], block));
      // the pool's two sides, but only OUR share of them — what unlock brings
      // back: the pair pays LP out pro rata against its balances, and anyone
      // else's liquidity (and their share of the coins) stays in the pool
      const pairToken = await read(token, tokenAbi, "balanceOf", [pair], block);
      const pairQuote = await read(quoteAsset, erc20Abi, "balanceOf", [pair], block);
      const lpTotal = await read(pair, pairAbi, "totalSupply", [], block);
      const lpOurs = await read(via, migratorAbi, "liquidity", [token], block);
      const lpOthers = lpTotal - lpOurs;
      realQuote = ((pairQuote * lpOurs) / lpTotal) * SCALE;
      if (lpOthers <= 1000n) {
        // only Uniswap's minimum liquidity, burned at the first mint, is not ours: its
        // dust of coins counts with the pool, so that holders + pool is the whole supply
        poolToken = pairToken;
      } else {
        // liquidity somebody else added: their share of the coins stays in this pool
        poolToken = (pairToken * lpOurs) / lpTotal;
        stranded = pairToken - poolToken;
        warnings.push(`${symbol}: the pool has liquidity besides ours (${lpOthers} of ${lpTotal} LP): that share stays in the pool on this chain`);
      }
    } else {
      poolToken = DEX_RESERVE; // graduated with its reserve parked in the pad: the DEX reserve is still there
    }
  }
  const excluded = new Set([launchpad.toLowerCase(), ...(pair ? [pair.toLowerCase()] : [])]);
  const holders = [];
  const amounts = [];
  const addresses = [...balances.keys()].filter((a) => balances.get(a) > 0n && !excluded.has(a.toLowerCase())).sort();
  for (const a of addresses) {
    const bal = await read(token, tokenAbi, "balanceOf", [a], block);
    if (bal !== balances.get(a)) throw new Error(`${symbol}: ${a} holds ${bal} at block ${block} but the transfers add up to ${balances.get(a)}: logs missing?`);
    if (bal === 0n) continue;
    holders.push(getAddress(a));
    amounts.push(bal);
  }
  if (graduated && stranded > 0n) {
    if (!vault) throw new Error(`${symbol}: ${stranded} coins sit in the pool with liquidity that is not ours; the receiving side needs holders + pool == supply. Pass --vault <address> to park them for their providers' claim, or migrate this coin by hand`);
    holders.push(vault);
    amounts.push(stranded);
    warnings.push(`${symbol}: ${stranded} coins of the pool's other liquidity providers parked in the vault ${vault} for a claim by hand`);
  }
  const owned = amounts.reduce((t, b) => t + b, 0n);
  // a graduated coin: holders (the vault included) own the supply less our share of the pool
  const expected = graduated ? TOTAL_SUPPLY - poolToken : sold;
  if (owned !== expected) {
    const padBal = await read(token, tokenAbi, "balanceOf", [launchpad], block);
    throw new Error(`${symbol}: holders own ${owned} but ${graduated ? "supply minus the pool" : "the curve's sold"} is ${expected} (the pad holds ${padBal}): the snapshot does not add up`);
  }
  if (holders.includes(getAddress(treasury))) warnings.push(`${symbol}: the treasury holds some (rounding leftovers of the pool seeding): it is listed as a holder`);
  bridgeWei += realQuote;
  sourceTokens[symbol] = token;
  coins.push({
    name,
    symbol,
    logo: meta.logoURI ?? meta[0],
    creator: getAddress(creator),
    feesToHolders,
    virtualQuote: (vEth - realEth) * SCALE,
    realQuote,
    sold: expected,
    poolToken,
    holders,
    balances: amounts,
  });
  console.log(`${symbol}: ${holders.length} holders · ${graduated ? "graduated, pool" : "curve"} ${Number(realQuote / SCALE) / 10 ** Number(quoteDecimals)} quote${pair ? ` · pair ${pair}` : ""}`);
}

// bigints as JSON numbers, for vm.parseJson
const big = (_, v) => (typeof v === "bigint" ? `__big_${v}` : v);
const numbers = (s) => s.replace(/"__big_(\d+)"/g, "$1");
const canonical = numbers(JSON.stringify(coins, big));
const stateRoot = keccak256(toHex(canonical)).slice(2);
const out = {
  network,
  chainId,
  launchpad,
  quoteAsset,
  height: block,
  freezeHeight: block,
  stateRoot,
  partial: false,
  generatedAt: new Date().toISOString(),
  totals: {
    coins: coins.length,
    holders: coins.reduce((t, c) => t + c.holders.length, 0),
    bridgeWei,
    bridgeLtc: (Number(bridgeWei / 10n ** 10n) / 1e8).toFixed(8),
    settleOnLitecoinLit: 0n,
    unresolved: 0,
    vault: null,
  },
  unresolved: [],
  sourceTokens,
  warnings,
  coins,
};
const outFile = flag("out", path.join(root, "..", "litecoin", "migration", `${network}-${block}.json`));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, numbers(JSON.stringify(out, big, 1)));
for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`${outFile}: ${coins.length} coins, ${out.totals.holders} holders, bridge ${out.totals.bridgeLtc} LTC · root ${stateRoot.slice(0, 16)}…`);
