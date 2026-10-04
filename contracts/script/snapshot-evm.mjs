// The migration file of an EVM launchpad, frozen for a move to another chain
// (Base → LitVM). Reads every coin at the freeze block — its curve, its
// metadata, who holds what (from the token's Transfer logs, checked against
// balanceOf), and for a graduated coin its pool's two sides — and writes the
// same file litecoin/migration-snapshot.ts writes for the Litecoin ledger, so
// MigrateFromLedger.s.sol re-creates the coins on the other side unchanged.
// Quote amounts are scaled to 18 decimals (cbLTC has 8; zkLTC is native).
//
//   node script/snapshot-evm.mjs --rpc https://mainnet.base.org,https://base-rpc.publicnode.com --launchpad 0x... \
//     --quote 0xcb17C9Db87B595717C857a08468793f5bAb6445F --from-block <pad deploy block> \
//     [--network base] [--out ../litecoin/migration/base-<block>.json] [--chunk 5000] [--allow-unfrozen] [--vault 0x...]
//
// Refuses a launchpad that is not frozen (the balances could still change)
// unless --allow-unfrozen, for a dry run at the latest block. Coins with no
// holder to go to — a graduated coin's pool holding liquidity besides the
// migrator's leaves those providers' share of the coins in the pool on this
// chain; coins somebody sent to the pad itself (a transfer to it passes) sit
// there unaccounted — go to --vault (an address of yours, for a claim by
// hand), since the receiving side needs holders + pool == supply less what a graduation locked; without
// one the run refuses. Run it unfrozen before announcing the freeze, so the
// day holds no surprise. Needs `forge build` (the ABIs come from out/) and
// web/'s node_modules (viem).
//
// --rpc takes several nodes, comma separated: public nodes throttle a run of
// a few hundred calls ("over rate limit"), so each call goes to the next node
// when one refuses, the whole chain is retried with a growing pause, and the
// calls are paced a little apart.
import fs from "node:fs";
import path from "node:path";
import { createPublicClient, fallback, http, keccak256, toHex, getAddress, parseAbiItem } from "../../web/node_modules/viem/_esm/index.js";

process.on("unhandledRejection", (e) => {
  console.error(`\nsnapshot failed: ${e?.shortMessage ?? e?.message ?? e}${e?.details ? ` (${e.details})` : ""}`);
  process.exit(1);
});

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
// --scale N: a mechanics-only rehearsal on a testnet short of coins. Every
// quote figure (virtual reserve, pots, the curve's reserve) comes out N times
// smaller, holders and their coins exactly as they are, so the receiving pad
// needs N times less quote and the price lands N times lower. Dry runs only.
const scale = BigInt(flag("scale", "1"));
if (scale < 1n) throw new Error("--scale must be 1 or more");
if (scale !== 1n && !allowUnfrozen) throw new Error("--scale is for a dry run: add --allow-unfrozen");

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
const GRADUATED = parseAbiItem("event Graduated(address indexed token, uint256 raisedEth)");

const rpcs = rpc.split(",").map((s) => s.trim()).filter(Boolean);
const client = createPublicClient({
  transport: fallback(
    rpcs.map((u) => http(u, { timeout: 20_000 })),
    { rank: false, retryCount: 5, retryDelay: 600 }
  ),
});
const PACE_MS = Number(flag("pace", "120")); // between calls, so one node's rate limit is not tripped
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chainId = await client.getChainId();
const read = async (address, abi_, functionName, args_ = [], blockNumber) => {
  await sleep(PACE_MS);
  return client.readContract({ address, abi: abi_, functionName, args: args_, blockNumber });
};
console.log(`${rpcs.length} RPC node${rpcs.length === 1 ? "" : "s"}: ${rpcs.join(", ")}`);

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
const VIRTUAL_TOKEN = await read(launchpad, padAbi, "VIRTUAL_TOKEN");
const treasury = await read(launchpad, padAbi, "treasury", [], block);

// ---- every coin
const count = await read(launchpad, padAbi, "tokenCount", [], block);
const tokens = [];
for (let i = 0n; i < count; i++) tokens.push(await read(launchpad, padAbi, "allTokens", [i], block));
console.log(`${tokens.length} coins`);

/** Logs of one event at one address in chunks, halving the chunk on an RPC error. */
async function logsOf(address, event, eventArgs) {
  const out = [];
  let from = fromBlock;
  let chunk = chunkDefault;
  while (from <= block) {
    const to = from + chunk - 1n > block ? block : from + chunk - 1n;
    try {
      await sleep(PACE_MS);
      const logs = await client.getLogs({ address, event, args: eventArgs, fromBlock: from, toBlock: to });
      out.push(...logs);
      from = to + 1n;
    } catch (e) {
      if (chunk <= 100n) throw e;
      chunk /= 2n;
      console.log(`  (a node refused ${to - from + 1n} blocks of logs: trying ${chunk})`);
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
  const [buyTaxBps, sellTaxBps, creatorBps, holdersBps, burnBps, liquidityBps] = await read(launchpad, padAbi, "feeConfig", [token], block);
  const burned = await read(launchpad, padAbi, "burned", [token], block);
  let burnPot = (await read(launchpad, padAbi, "burnPot", [token], block)) * SCALE;
  let liquidityPot = (await read(launchpad, padAbi, "liquidityPot", [token], block)) * SCALE;
  if ((await read(launchpad, padAbi, "migrationPending", [token], block)) !== 0n) throw new Error(`${symbol}: a migrated coin still delivering its holders cannot migrate again yet`);

  // holders: fold the transfers, then trust only balanceOf at the block
  const balances = new Map();
  const ZERO = "0x0000000000000000000000000000000000000000";
  for (const log of await logsOf(token, TRANSFER)) {
    const { from, to, value } = log.args;
    // the mint at birth comes from nowhere; a burn (a buyback's coins) goes nowhere
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + value);
  }
  let pair = null;
  let poolToken = 0n;
  let stranded = 0n; // coins in the pool that belong to other liquidity providers
  const excludedExtra = []; // other addresses whose coins are the pool's, not a holder's
  let realQuote = realEth * SCALE;
  // the curve's virtual reserve is vEth less what the curve raised; a graduated coin
  // whose reserve went to its pool keeps the whole raise in vEth with realEth at zero,
  // so the raise is read from its Graduated log (a parked one still holds it as realEth)
  let raised = realEth;
  if (graduated) {
    const grads = await logsOf(launchpad, GRADUATED, { token });
    if (grads.length !== 1) throw new Error(`${symbol}: ${grads.length} Graduated logs where one is expected`);
    raised = grads[0].args.raisedEth;
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
      // the v2 adapter parks a reserve the pool would not take at the closing price: it
      // waits in the adapter, still the coin's, and unlock brings it back with the pool's share
      let parkedToken = 0n;
      let parkedQuote = 0n;
      try {
        [parkedToken, parkedQuote] = await read(via, migratorAbi, "parked", [token], block);
      } catch {
        /* the v1 adapter knows no parking */
      }
      if (parkedToken > 0n || parkedQuote > 0n) {
        excludedExtra.push(via.toLowerCase()); // the adapter holds the parked coins: not a holder
        warnings.push(`${symbol}: ${parkedToken} coins and ${parkedQuote} quote wait in the migrator (the pool held liquidity at another price when it graduated); they migrate as the pool side`);
      }
      const lpOthers = lpTotal - lpOurs;
      realQuote = ((lpTotal === 0n ? 0n : (pairQuote * lpOurs) / lpTotal) + parkedQuote) * SCALE;
      if (lpTotal === 0n) {
        poolToken = parkedToken; // nothing of ours in the pool yet
      } else if (lpOthers <= 1000n) {
        // only Uniswap's minimum liquidity, burned at the first mint, is not ours: its
        // dust of coins counts with the pool, so that holders + pool is the whole supply
        poolToken = pairToken + parkedToken;
      } else {
        // liquidity somebody else added: their share of the coins stays in this pool
        poolToken = (pairToken * lpOurs) / lpTotal + parkedToken;
        stranded = pairToken - (pairToken * lpOurs) / lpTotal;
        warnings.push(`${symbol}: the pool has liquidity besides ours (${lpOthers} of ${lpTotal} LP): that share stays in the pool on this chain`);
      }
    } else {
      poolToken = DEX_RESERVE; // graduated with its reserve parked in the pad: the DEX reserve is still there
    }
  }
  const excluded = new Set([launchpad.toLowerCase(), ...(pair ? [pair.toLowerCase()] : []), ...excludedExtra]);
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
  // what the pad should hold: the unsold curve (the DEX reserve included), the DEX reserve
  // alone once graduated with its pool never seeded, nothing once the pool is seeded. More
  // than that is coins holders sent to the pad themselves (a transfer to it passes before
  // graduation): the pad never counts them, so on the ledger they have no holder
  const padBal = await read(token, tokenAbi, "balanceOf", [launchpad], block);
  // a coin graduated on a v11 pad keeps the curve's virtual share of its DEX reserve locked in the pad
  // (the pool opened at the closing price); earlier pads have no such getter and locked nothing
  let locked = 0n;
  if (graduated && pair) {
    try {
      locked = await read(launchpad, padAbi, "lockedAtGraduation", [token], block);
    } catch {
      /* an older pad */
    }
  }
  const expectedPad = !graduated ? TOTAL_SUPPLY - sold : pair ? locked : DEX_RESERVE;
  if (padBal < expectedPad) throw new Error(`${symbol}: the pad holds ${padBal} coins, less than the ${expectedPad} it should: the snapshot does not add up`);
  const excess = padBal - expectedPad;
  const unowned = [];
  if (stranded > 0n) unowned.push(`${stranded} coins of the pool's other liquidity providers`);
  if (excess > 0n) unowned.push(`${excess} coins holders sent to the pad`);
  if (unowned.length) {
    if (!vault) throw new Error(`${symbol}: ${unowned.join(" and ")} have no holder to go to; the receiving side needs holders + pool == supply less what a graduation locked. Pass --vault <address> to park them for a claim by hand, or migrate this coin by hand`);
    if (holders.includes(vault)) throw new Error(`${symbol}: the vault ${vault} holds this coin itself and a holder can be listed once; choose another --vault`);
    holders.push(vault);
    amounts.push(stranded + excess);
    warnings.push(`${symbol}: ${unowned.join(" and ")} parked in the vault ${vault} for a claim by hand`);
  }
  const owned = amounts.reduce((t, b) => t + b, 0n);
  // holders (the vault included) own what left the curve less what was burned; for a graduated
  // coin that is the supply less our share of the pool, less what stayed locked in the pad, less the burn
  const expected = (graduated ? TOTAL_SUPPLY - poolToken - locked : sold) - burned;
  if (owned !== expected) {
    throw new Error(`${symbol}: holders own ${owned} but ${graduated ? "supply minus the pool and the lock" : "the curve's sold"} is ${expected} (the pad holds ${padBal}): the snapshot does not add up`);
  }
  if (holders.includes(getAddress(treasury))) warnings.push(`${symbol}: the treasury holds some (rounding leftovers of the pool seeding): it is listed as a holder`);
  let virtualQuote = (vEth - raised) * SCALE;
  if (scale !== 1n) {
    // the quote side shrunk `scale` times; a curve's reserve follows the contract's
    // own formula from the shrunk virtual reserve, so the receiving pad finds it exact
    virtualQuote /= scale;
    burnPot /= scale;
    liquidityPot /= scale;
    const soldNow = expected + burned;
    realQuote = graduated ? realQuote / scale : soldNow === 0n ? 0n : (virtualQuote * soldNow) / (VIRTUAL_TOKEN - soldNow);
  }
  bridgeWei += realQuote + burnPot + liquidityPot;
  sourceTokens[symbol] = token;
  coins.push({
    name,
    symbol,
    logo: meta.logoURI ?? meta[0],
    creator: getAddress(creator),
    buyTaxBps: BigInt(buyTaxBps),
    sellTaxBps: BigInt(sellTaxBps),
    creatorBps: BigInt(creatorBps),
    holdersBps: BigInt(holdersBps),
    burnBps: BigInt(burnBps),
    liquidityBps: BigInt(liquidityBps),
    virtualQuote,
    realQuote,
    sold: expected + burned, // what left the curve: holders' coins and the burned ones
    burned,
    poolToken,
    burnPot,
    liquidityPot,
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
  scale: Number(scale),
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
if (scale !== 1n) console.log(`SCALED 1:${scale} — a mechanics rehearsal: every quote figure is ${scale}× smaller than the source's, prices ${scale}× lower; never for a real migration`);
