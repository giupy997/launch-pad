// The migration file of an EVM launchpad, frozen for a move — to another chain
// (Base → LitVM) or to a new pad on the same chain (Base v11 → Base v12).
// Reads every coin at the freeze block — its curve, its metadata, its fee
// configuration, who holds what (from the token's Transfer logs, checked
// against balanceOf), and for a graduated coin its pool's two sides — and
// writes the same file litecoin/migration-snapshot.ts writes for the Litecoin
// ledger, so MigrateFromLedger.s.sol re-creates the coins on the other side
// unchanged. Every quote figure is written in the DESTINATION quote's units
// (--out-decimals: 18 for native zkLTC, 8 for cbLTC), so the receiving pad
// needs no conversion; --dest-quote names that asset in the file.
//
//   node script/snapshot-evm.mjs --launchpad 0x... --quote 0xcb17C9Db87B595717C857a08468793f5bAb6445F --from-block <pad deploy block> \
//     [--rpc url,url] [--network base] [--dest-quote 0x...|native] [--out-decimals 18] \
//     [--out ../litecoin/migration/base-<block>.json] [--chunk 5000] [--pace 120] \
//     [--allow-unfrozen] [--vault 0x...] [--allow-contract-holders] [--scale N]
//     [--fees SYMBOL=buy/sell/creator/holders/burn/liquidity,...]
//   --rpc may be left out when SRC_RPC is in the environment; --pace is the ms between calls;
//   --quote is the SOURCE pad's quote asset (`native` for a pad quoted in the chain's coin);
//   --fees gives a coin a fee configuration other than the one it has on the source (in basis
//   points: taxes up to 1000 each, the four shares adding to 10,000) — a coin its creator
//   relaunches with a tax on the new pad, holders and price untouched; written in the file's
//   `feeOverrides` and warnings, so the record says what changed
//
// Refuses a launchpad that is not frozen (the balances could still change)
// unless --allow-unfrozen, for a dry run at the latest block. Coins with no
// holder to go to — a graduated coin's pool holding liquidity besides the
// migrator's leaves those providers' share of the coins in the pool on this
// chain; coins somebody sent to the pad itself (a transfer to it passes) sit
// there unaccounted — go to --vault (an address of yours, for a claim by
// hand), since the receiving side needs holders + pool == supply less what a
// graduation locked; without one the run refuses. Holders that are contracts
// are listed in the warnings and refused without --allow-contract-holders:
// on another chain nothing may live at their address (a move to a new pad on
// the same chain passes the flag). Run it unfrozen before announcing the
// freeze, so the day holds no surprise. Needs web/'s node_modules (viem);
// the ABIs it needs are written here, so it reads a v11 pad and a v12 pad
// alike (the fee configuration has six fields on one, seven on the other;
// a v12 pad's unsold pool fees — its tax buckets — are counted as burned,
// since migrateOut burns them).
//
// --rpc takes several nodes, comma separated: public nodes throttle a run of
// a few hundred calls ("over rate limit"), so each call goes to the next node
// when one refuses, the whole chain is retried with a growing pause, and the
// calls are paced a little apart.
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  fallback,
  http,
  keccak256,
  toHex,
  getAddress,
  parseAbiItem,
  formatUnits,
  zeroAddress,
} from "../../web/node_modules/viem/_esm/index.js";

// Every crash goes through one printer: viem quotes the request URL in its
// messages, and a keyed node's URL carries its key, so every configured URL
// is cut to its host before anything is printed. A rejection at the top
// level of a module reaches Node as an uncaught exception, so both are
// caught; Node's own printer, which dumps the whole error, never runs.
let scrubUrls = [];
const scrub = (s) => {
  let t = String(s);
  for (const u of scrubUrls) t = t.split(u).join(nodeName(u));
  return t.replace(/https?:\/\/[^\s"'<>)]+/g, (u) => `https://${nodeName(u)}/…`);
};
const die = (e) => {
  console.error(`\nsnapshot failed: ${scrub(e?.shortMessage ?? e?.message ?? e)}${e?.details ? ` (${scrub(e.details).slice(0, 300)})` : ""}`);
  process.exit(1);
};
process.on("unhandledRejection", die);
process.on("uncaughtException", die);
// a keyed node's URL carries its key: shown as its host alone
const nodeName = (u) => { try { return new URL(u).host; } catch { return "a node"; } };

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
// `--name value`; an empty value ("" from an unset shell variable) counts as absent
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && args[i + 1] !== "" && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const need = (name) => {
  const v = flag(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
};
const positive = (name, fallback) => {
  const v = BigInt(flag(name, fallback));
  if (v < 1n) throw new Error(`--${name} must be 1 or more`);
  return v;
};
// an asset flag: an address, or `native` (0x0) for the chain's own coin
const asset = (v) => (v === "native" || /^0x0{1,40}$/i.test(v) ? zeroAddress : getAddress(v));

// --rpc, or SRC_RPC from the environment: on a server a URL in the command
// line shows in the process list, a variable does not
const rpc = flag("rpc") ?? process.env.SRC_RPC;
if (!rpc) throw new Error("--rpc <url,url,...> is required (or SRC_RPC in the environment)");
const launchpad = getAddress(need("launchpad"));
const quoteAsset = asset(need("quote"));
const fromBlock = BigInt(need("from-block"));
const network = flag("network", "base");
const chunkDefault = positive("chunk", "5000");
const allowUnfrozen = args.includes("--allow-unfrozen");
const allowContractHolders = args.includes("--allow-contract-holders");
const vault = flag("vault") ? getAddress(flag("vault")) : null;
// the destination's quote: what the receiving pad funds the coins in, and the
// unit every quote figure of the file is written in
const destQuote = asset(flag("dest-quote", "native"));
const outDecimals = BigInt(flag("out-decimals", "18"));
if (outDecimals > 36n) throw new Error("--out-decimals: 36 at most");
// --scale N: a mechanics-only rehearsal on a testnet short of coins. Every
// quote figure (virtual reserve, pots, the curve's reserve) comes out N times
// smaller, holders and their coins exactly as they are, so the receiving pad
// needs N times less quote and the price lands N times lower. Dry runs only.
const scale = BigInt(flag("scale", "1"));
if (scale < 1n) throw new Error("--scale must be 1 or more");
if (scale !== 1n && !allowUnfrozen) throw new Error("--scale is for a dry run: add --allow-unfrozen");
// --fees SYMBOL=buy/sell/creator/holders/burn/liquidity: the fee configuration a coin takes on the
// new pad instead of its own (the pad validates the same bounds at migrateToken)
const feeOverrides = {};
for (const spec of (flag("fees") ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
  const m = /^([^=]+)=(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`--fees: "${spec}" is not SYMBOL=buy/sell/creator/holders/burn/liquidity`);
  const [buy, sell, creator, holders, burn, liquidity] = m.slice(2).map(Number);
  if (buy > 1000 || sell > 1000) throw new Error(`--fees ${m[1]}: a tax is 1000 bps (10%) at most`);
  if (creator + holders + burn + liquidity !== 10_000) throw new Error(`--fees ${m[1]}: the four shares must add to 10,000`);
  feeOverrides[m[1]] = { buyTaxBps: buy, sellTaxBps: sell, creatorBps: creator, holdersBps: holders, burnBps: burn, liquidityBps: liquidity };
}

// The ABIs, written here rather than read from out/: a v11 pad and a v12 pad
// answer the same questions with one difference (feeConfig's seventh field),
// and the getters only one of them has are read with a fallback.
const fn = (s) => parseAbiItem(`function ${s}`);
const padAbi = [
  fn("freezeBlock() view returns (uint256)"),
  fn("TOTAL_SUPPLY() view returns (uint256)"),
  fn("DEX_RESERVE() view returns (uint256)"),
  fn("VIRTUAL_TOKEN() view returns (uint256)"),
  fn("treasury() view returns (address)"),
  fn("feeBps() view returns (uint256)"),
  fn("tokenCount() view returns (uint256)"),
  fn("allTokens(uint256) view returns (address)"),
  fn("curves(address) view returns (uint256 vEth, uint256 vToken, uint256 realEth, uint256 sold, bool graduated, address creator, address quoteAsset)"),
  fn("tokenMetadata(address) view returns (string logoURI, string website, string twitter, string telegram, string livestream, string description)"),
  fn("burned(address) view returns (uint256)"),
  fn("burnPot(address) view returns (uint256)"),
  fn("liquidityPot(address) view returns (uint256)"),
  fn("migrationPending(address) view returns (uint256)"),
  fn("graduatedVia(address) view returns (address)"),
  fn("lockedAtGraduation(address) view returns (uint256)"),
  fn("feeRecipient(address) view returns (address)"),
  fn("taxTreasury(address) view returns (uint256)"),
  fn("taxPot(address) view returns (uint256)"),
];
const feeConfigAbi7 = [fn("feeConfig(address) view returns (uint16,uint16,uint16,uint16,uint16,uint16,uint16)")];
const feeConfigAbi6 = [fn("feeConfig(address) view returns (uint16,uint16,uint16,uint16,uint16,uint16)")];
const tokenAbi = [
  fn("symbol() view returns (string)"),
  fn("name() view returns (string)"),
  fn("balanceOf(address) view returns (uint256)"),
];
const migratorAbi = [
  fn("pairOf(address) view returns (address)"),
  fn("liquidity(address) view returns (uint256)"),
  fn("parked(address) view returns (uint256 tokenAmount, uint256 quoteAmount)"),
];
const pairAbi = [
  fn("token0() view returns (address)"),
  fn("token1() view returns (address)"),
  fn("totalSupply() view returns (uint256)"),
  fn("balanceOf(address) view returns (uint256)"),
];
const erc20Abi = [
  fn("decimals() view returns (uint8)"),
  fn("balanceOf(address) view returns (uint256)"),
];
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const GRADUATED = parseAbiItem("event Graduated(address indexed token, uint256 raisedEth)");

const rpcs = rpc.split(",").map((s) => s.trim()).filter(Boolean);
scrubUrls = rpcs;
// Every node here must serve the chain's whole history: viem's fallback moves
// to the next node on an error, and a node that keeps only recent blocks
// answers a range it does not have with an empty list, not an error, which
// would leave a gap (the add-up checks below catch it, but the run dies).
// Few retries of the whole chain of nodes: logsOf has its own patient waits.
const client = createPublicClient({
  transport: fallback(
    rpcs.map((u) => http(u, { timeout: 20_000 })),
    { rank: false, retryCount: 2, retryDelay: 600 }
  ),
});
const PACE_MS = Number(flag("pace", "120")); // between calls, so one node's rate limit is not tripped
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chainId = await client.getChainId();
const read = async (address, abi_, functionName, args_ = [], blockNumber) => {
  await sleep(PACE_MS);
  return client.readContract({ address, abi: abi_, functionName, args: args_, blockNumber });
};
// A node that could not be reached is a failure of the run, never a value:
// only a contract that lacks a getter (an older pad) answers with the fallback.
const transportFailure = (e) => {
  for (let x = e; x; x = x.cause) {
    if (/HttpRequestError|TimeoutError|RpcRequestError|WebSocketRequestError|InternalRpcError|LimitExceededRpcError|ResourceUnavailableRpcError/.test(x.name ?? "")) return true;
  }
  return false;
};
const readOr = async (address, abi_, functionName, args_, blockNumber, fallbackValue) => {
  try {
    return await read(address, abi_, functionName, args_, blockNumber);
  } catch (e) {
    if (transportFailure(e)) throw e;
    return fallbackValue;
  }
};
const codeAt = async (address, blockNumber) => {
  await sleep(PACE_MS);
  const get = client.getCode ?? client.getBytecode;
  const code = await get.call(client, { address, blockNumber });
  return code && code !== "0x";
};
console.log(`${rpcs.length} RPC node${rpcs.length === 1 ? "" : "s"}: ${rpcs.map(nodeName).join(", ")}`);

// ---- the block: the freeze, reached
const freezeBlock = await read(launchpad, padAbi, "freezeBlock");
const latest = await client.getBlockNumber();
let block;
if (freezeBlock !== 0n && latest >= freezeBlock) block = freezeBlock;
else if (allowUnfrozen) block = latest;
else throw new Error(freezeBlock === 0n ? "the launchpad is not frozen: no freeze announced (balances can still change; --allow-unfrozen for a dry run)" : `the freeze at block ${freezeBlock} is not reached (chain at ${latest})`);
console.log(`chain ${chainId} · launchpad ${launchpad} · snapshot at block ${block}${block === freezeBlock ? " (the freeze)" : " (UNFROZEN dry run)"}`);

// ---- units: the source's quote in, the destination's out
const srcDecimals = quoteAsset === zeroAddress ? 18n : BigInt(await read(quoteAsset, erc20Abi, "decimals"));
const toOut = (x) => (outDecimals >= srcDecimals ? x * 10n ** (outDecimals - srcDecimals) : x / 10n ** (srcDecimals - outDecimals));
const outUnits = (x) => formatUnits(x, Number(outDecimals));
console.log(`quote ${quoteAsset === zeroAddress ? "native" : quoteAsset} (${srcDecimals} decimals) → ${destQuote === zeroAddress ? "native" : destQuote} (${outDecimals} decimals)`);
if (outDecimals < srcDecimals) console.warn(`warning: the destination counts in fewer decimals than the source: every quote figure is floored to its units`);
const TOTAL_SUPPLY = await read(launchpad, padAbi, "TOTAL_SUPPLY");
const DEX_RESERVE = await read(launchpad, padAbi, "DEX_RESERVE");
const VIRTUAL_TOKEN = await read(launchpad, padAbi, "VIRTUAL_TOKEN");
const treasury = await read(launchpad, padAbi, "treasury", [], block);
const padFeeBps = await readOr(launchpad, padAbi, "feeBps", [], block, null);

// ---- every coin
const count = await read(launchpad, padAbi, "tokenCount", [], block);
const tokens = [];
for (let i = 0n; i < count; i++) tokens.push(await read(launchpad, padAbi, "allTokens", [i], block));
console.log(`${tokens.length} coins`);

/** Logs of one event at one address in chunks. A refusal is first waited out
 *  (public nodes limit by IP and recover in seconds: every retry waits twice
 *  as long, up to a minute), and only a range that keeps failing is halved;
 *  the run gives up only after many patient attempts on a small range. */
const MAX_WAITS = 6; // waits before a range is halved: 3, 6, 12, 24, 48, 60 s
async function logsOf(address, event, eventArgs) {
  const out = [];
  let from = fromBlock;
  let chunk = chunkDefault;
  let waits = 0;
  while (from <= block) {
    const to = from + chunk - 1n > block ? block : from + chunk - 1n;
    try {
      await sleep(PACE_MS);
      const logs = await client.getLogs({ address, event, args: eventArgs, fromBlock: from, toBlock: to });
      out.push(...logs);
      from = to + 1n;
      waits = 0;
    } catch (e) {
      // what the node said, not viem's summary of it: the JSON-RPC error text or the HTTP body, URLs cut to their host
      const why = scrub(String(e?.details || e?.cause?.details || e?.cause?.message || e?.shortMessage || e?.message || e))
        .replace(/\s+/g, " ")
        .slice(0, 160);
      if (waits < MAX_WAITS) {
        const wait = Math.min(60_000, 3_000 * 2 ** waits);
        waits++;
        console.log(`  (the nodes refused ${to - from + 1n} blocks of logs: ${why}; waiting ${wait / 1000}s, attempt ${waits}/${MAX_WAITS})`);
        await sleep(wait);
      } else if (chunk > 100n) {
        chunk /= 2n;
        waits = 0;
        console.log(`  (still refused: trying ${chunk} blocks a call)`);
      } else {
        throw e;
      }
    }
  }
  return out;
}

const coins = [];
const sourceTokens = {};
const warnings = [];
const contractHolders = [];
const ZERO = zeroAddress;
let bridgeWei = 0n;
for (const token of tokens) {
  const [vEth, vToken, realEth, sold, graduated, creator, coinQuote] = await read(launchpad, padAbi, "curves", [token], block);
  const symbol = await read(token, tokenAbi, "symbol", [], block);
  const name = await read(token, tokenAbi, "name", [], block);
  if (getAddress(coinQuote) !== quoteAsset) {
    warnings.push(`${symbol}: quoted in ${coinQuote}, not the migrating quote asset — left out`);
    continue;
  }
  if (sourceTokens[symbol]) throw new Error(`${symbol}: two coins share this ticker (${sourceTokens[symbol]} and ${token}); the receiving pad names one token per ticker — migrate one of them by hand`);
  const [logoURI, website, twitter, telegram, livestream, description] = await read(launchpad, padAbi, "tokenMetadata", [token], block);
  // seven fields on a v12 pad, six on a v11: the seventh (the launchpad's own
  // rate, stamped at creation) is not carried — the receiving pad stamps its own
  let fees;
  try {
    fees = await read(launchpad, feeConfigAbi7, "feeConfig", [token], block);
  } catch (e) {
    if (transportFailure(e)) throw e;
    fees = await read(launchpad, feeConfigAbi6, "feeConfig", [token], block);
  }
  let [buyTaxBps, sellTaxBps, creatorBps, holdersBps, burnBps, liquidityBps] = fees;
  if (feeOverrides[symbol]) {
    const o = feeOverrides[symbol];
    warnings.push(`${symbol}: fees set for the new pad by --fees: ${o.buyTaxBps}/${o.sellTaxBps} bps tax, shares ${o.creatorBps}/${o.holdersBps}/${o.burnBps}/${o.liquidityBps} (on the source: ${buyTaxBps}/${sellTaxBps}, ${creatorBps}/${holdersBps}/${burnBps}/${liquidityBps})`);
    ({ buyTaxBps, sellTaxBps, creatorBps, holdersBps, burnBps, liquidityBps } = o);
  }
  const feeRecipient = getAddress(await readOr(launchpad, padAbi, "feeRecipient", [token], block, ZERO));
  const burnedOnChain = await read(launchpad, padAbi, "burned", [token], block);
  let burnPot = toOut(await read(launchpad, padAbi, "burnPot", [token], block));
  let liquidityPot = toOut(await read(launchpad, padAbi, "liquidityPot", [token], block));
  if ((await read(launchpad, padAbi, "migrationPending", [token], block)) !== 0n) throw new Error(`${symbol}: a migrated coin still delivering its holders cannot migrate again yet`);
  // a v12 pad keeps the fees its pool trades left in coins, unsold, in two
  // buckets; migrateOut burns whatever a harvest did not sell, so they count as burned
  const taxBuckets = (await readOr(launchpad, padAbi, "taxTreasury", [token], block, 0n)) + (await readOr(launchpad, padAbi, "taxPot", [token], block, 0n));
  if (taxBuckets !== 0n) warnings.push(`${symbol}: ${taxBuckets} coins of unsold pool fees sit in the pad: migrateOut burns them (harvest first, after the freeze is announced, to turn them into quote)`);
  const burned = burnedOnChain + taxBuckets;

  // holders: fold the transfers, then trust only balanceOf at the block
  const balances = new Map();
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
  let realQuote = toOut(realEth);
  // the curve's virtual reserve is vEth less what the curve raised; a graduated coin
  // whose reserve went to its pool keeps the whole raise in vEth with realEth at zero,
  // so the raise is read from its Graduated log (a parked one still holds it as realEth)
  let raised = realEth;
  if (graduated) {
    const grads = await logsOf(launchpad, GRADUATED, { token });
    if (grads.length !== 1) throw new Error(`${symbol}: ${grads.length} Graduated logs where one is expected`);
    raised = grads[0].args.raisedEth;
    const via = await read(launchpad, padAbi, "graduatedVia", [token], block);
    if (via !== ZERO) {
      pair = getAddress(await read(via, migratorAbi, "pairOf", [token], block));
      // the pool's two sides, but only OUR share of them — what unlock brings
      // back: the pair pays LP out pro rata against its balances, and anyone
      // else's liquidity (and their share of the coins) stays in the pool. The
      // quote side is whatever the pair holds against the coin (WETH for a
      // native pad, the ERC-20 otherwise).
      const t0 = getAddress(await read(pair, pairAbi, "token0", [], block));
      const t1 = getAddress(await read(pair, pairAbi, "token1", [], block));
      const pairQuoteAsset = t0 === getAddress(token) ? t1 : t0;
      if (quoteAsset !== zeroAddress && pairQuoteAsset !== quoteAsset) throw new Error(`${symbol}: its pool ${pair} pairs it with ${pairQuoteAsset}, not the pad's quote`);
      const pairToken = await read(token, tokenAbi, "balanceOf", [pair], block);
      const pairQuote = await read(pairQuoteAsset, erc20Abi, "balanceOf", [pair], block);
      const lpTotal = await read(pair, pairAbi, "totalSupply", [], block);
      const lpOurs = await read(via, migratorAbi, "liquidity", [token], block);
      // the v2 adapter parks a reserve the pool would not take at the closing price: it
      // waits in the adapter, still the coin's, and unlock brings it back with the pool's share
      const [parkedToken, parkedQuote] = await readOr(via, migratorAbi, "parked", [token], block, [0n, 0n]); // the v1 adapter knows no parking
      if (parkedToken > 0n || parkedQuote > 0n) {
        excludedExtra.push(via.toLowerCase()); // the adapter holds the parked coins: not a holder
        warnings.push(`${symbol}: ${parkedToken} coins and ${parkedQuote} quote wait in the migrator (the pool held liquidity at another price when it graduated); they migrate as the pool side`);
      }
      const lpOthers = lpTotal - lpOurs;
      realQuote = toOut((lpTotal === 0n ? 0n : (pairQuote * lpOurs) / lpTotal) + parkedQuote);
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
    // a contract holds some: on another chain nothing may answer at its address
    if (await codeAt(a, block)) contractHolders.push(`${symbol}: ${getAddress(a)} (${bal} coins)`);
  }
  // what the pad should hold: the unsold curve (the DEX reserve included), the DEX reserve
  // alone once graduated with its pool never seeded, nothing once the pool is seeded — plus
  // the tax buckets of a v12 pad. More than that is coins holders sent to the pad themselves
  // (a transfer to it passes before graduation): the pad never counts them, so on the
  // ledger they have no holder
  const padBal = await read(token, tokenAbi, "balanceOf", [launchpad], block);
  // a coin graduated on a v11 pad or later keeps the curve's virtual share of its DEX reserve
  // locked in the pad (the pool opened at the closing price); earlier pads have no such getter
  const locked = graduated && pair ? await readOr(launchpad, padAbi, "lockedAtGraduation", [token], block, 0n) : 0n;
  const expectedPad = (!graduated ? TOTAL_SUPPLY - sold : pair ? locked : DEX_RESERVE) + taxBuckets;
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
  // coin that is the supply less our share of the pool, less what stayed locked in the pad, less
  // the burn (the tax buckets, burned at migrateOut, included)
  const expected = (graduated ? TOTAL_SUPPLY - poolToken - locked : sold) - burned;
  if (owned !== expected) {
    throw new Error(`${symbol}: holders own ${owned} but ${graduated ? "supply minus the pool, the lock and the burn" : "the curve's sold less the burn"} is ${expected} (the pad holds ${padBal}): the snapshot does not add up`);
  }
  if (holders.includes(getAddress(treasury))) warnings.push(`${symbol}: the treasury holds some (rounding leftovers of the pool seeding): it is listed as a holder`);
  let virtualQuote = toOut(vEth - raised);
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
  // the keys in the order vm.parseJson lays them out (alphabetical), so the
  // script's Coin struct reads them straight
  coins.push({
    name,
    symbol,
    logo: logoURI,
    website,
    twitter,
    telegram,
    livestream,
    description,
    creator: getAddress(creator),
    feeRecipient,
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
  console.log(`${symbol}: ${holders.length} holders · ${graduated ? "graduated, pool" : "curve"} ${outUnits(realQuote)} quote${pair ? ` · pair ${pair}` : ""}${taxBuckets !== 0n ? ` · ${taxBuckets} coins of fees to burn` : ""}`);
}
for (const sym of Object.keys(feeOverrides)) {
  if (!sourceTokens[sym]) throw new Error(`--fees names ${sym}, which is not a coin of this pad (${Object.keys(sourceTokens).join(", ")})`);
}
if (contractHolders.length) {
  for (const h of contractHolders) warnings.push(`a contract holds coins: ${h}`);
  if (!allowContractHolders) throw new Error(`${contractHolders.length} holder${contractHolders.length === 1 ? " is a contract" : "s are contracts"} (${contractHolders.join("; ")}): on another chain nothing may live at that address. Pass --allow-contract-holders when the destination is the same chain, or settle with them first`);
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
  quoteAsset, // the source pad's
  quoteDecimals: Number(srcDecimals),
  destQuote, // what the receiving pad funds the coins in: every quote figure below is in its units
  destQuoteDecimals: Number(outDecimals),
  padFeeBps: padFeeBps === null ? null : Number(padFeeBps),
  height: block,
  freezeHeight: block,
  stateRoot,
  scale: Number(scale),
  partial: false,
  generatedAt: new Date().toISOString(),
  totals: {
    coins: coins.length,
    holders: coins.reduce((t, c) => t + c.holders.length, 0),
    bridgeWei, // in the destination's units, the name notwithstanding
    bridgeLtc: outUnits(bridgeWei),
    settleOnLitecoinLit: 0n,
    unresolved: 0,
    vault: vault,
  },
  unresolved: [],
  sourceTokens,
  feeOverrides,
  warnings,
  coins,
};
const outFile = flag("out", path.join(root, "..", "litecoin", "migration", `${network}-${block}.json`));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, numbers(JSON.stringify(out, big, 1)));
for (const w of warnings) console.warn(`warning: ${w}`);
console.log(`${outFile}: ${coins.length} coins, ${out.totals.holders} holders, ${out.totals.bridgeLtc} quote to deliver (${outDecimals} decimals) · root ${stateRoot.slice(0, 16)}…`);
if (scale !== 1n) console.log(`SCALED 1:${scale} — a mechanics rehearsal: every quote figure is ${scale}× smaller than the source's, prices ${scale}× lower; never for a real migration`);
