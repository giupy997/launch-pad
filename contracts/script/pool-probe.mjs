// What a graduated coin's pool holds, and what happened in it. For every coin
// of a launchpad (or one, --token): its curve; for a graduated coin, the pool
// its graduation seeded (what went in, what it holds now, the price and the
// market cap there, how much of the liquidity the pad's migrator keeps
// locked, the floor the pool can fall to) and every swap, liquidity add and
// removal in that pool since, with the wallet behind each and the reserves
// and market cap after it. For reading a graduation after the fact, when a
// trading terminal's numbers make no sense.
//
//   node script/pool-probe.mjs --rpc https://mainnet.base.org,https://base-rpc.publicnode.com \
//     --launchpad 0x... --from-block <pad deploy block> [--token 0x...] [--chunk 1999] [--usd <LTC price>] [--no-usd]
//
// Needs web/'s node_modules (viem), no forge build. --rpc takes several nodes
// comma separated, like snapshot-evm.mjs: a call goes to the next node when
// one refuses, the calls are paced a little apart, and a range of logs a node
// won't serve is halved and retried. Dollar figures use the LTC price from
// CoinGecko (or --usd) for LTC-like quotes; --no-usd leaves them out.
import { createPublicClient, fallback, http, getAddress, parseAbi, formatUnits } from "../../web/node_modules/viem/_esm/index.js";

process.on("unhandledRejection", (e) => {
  console.error(`\nprobe failed: ${e?.shortMessage ?? e?.message ?? e}${e?.details ? ` (${e.details})` : ""}`);
  process.exit(1);
});

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const need = (name) => {
  const v = flag(name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
};

const rpcs = need("rpc").split(",").map((s) => s.trim()).filter(Boolean);
const launchpad = getAddress(need("launchpad"));
const fromBlock = BigInt(need("from-block"));
const only = flag("token") ? getAddress(flag("token")) : null;
let chunk = BigInt(flag("chunk", "1999"));
const PACE_MS = Number(flag("pace", "120"));
const ZERO = "0x0000000000000000000000000000000000000000";
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;

const padAbi = parseAbi([
  "function tokenCount() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function curves(address) view returns (uint256 vEth, uint256 vToken, uint256 realEth, uint256 sold, bool graduated, address creator, address quoteAsset)",
  "function graduatedVia(address) view returns (address)",
  "function treasury() view returns (address)",
  "event Graduated(address indexed token, uint256 raisedEth)",
  "event Migrated(address indexed token, uint256 tokenAmount, uint256 ethAmount)",
  "event AutoMigrationFailed(address indexed token)",
]);
const migratorAbi = parseAbi([
  "function pairOf(address) view returns (address)",
  "function pairAsset(address) view returns (address)",
  "function liquidity(address) view returns (uint256)",
  "event PoolSeeded(address indexed token, address pair, uint256 tokenAmount, uint256 quoteAmount, uint256 liquidity)",
  "event PoolRebalanced(address indexed token, address pair, uint256 tokenIn, uint256 quoteIn)", // the v1 adapter
  "event PoolParked(address indexed token, address pair, uint256 tokenAmount, uint256 quoteAmount)", // v2
  "event PoolNudged(address indexed token, address pair, uint256 tokenIn, uint256 quoteIn)", // v2
]);
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function totalSupply() view returns (uint256)",
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)",
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
  "event Sync(uint112 reserve0, uint112 reserve1)",
]);
const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const eventsOf = (abi) => abi.filter((x) => x.type === "event");

const client = createPublicClient({
  transport: fallback(
    rpcs.map((u) => http(u, { timeout: 20_000 })),
    { rank: false, retryCount: 5, retryDelay: 600 }
  ),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = async (address, abi, functionName, args_ = []) => {
  await sleep(PACE_MS);
  return client.readContract({ address, abi, functionName, args: args_ });
};

/** Every log of `events` at `address` between two blocks, in ranges the nodes
 *  accept, oldest first. */
async function logs(address, events, from, to) {
  const out = [];
  let cur = from;
  let n = 0;
  while (cur <= to) {
    const end = cur + chunk - 1n > to ? to : cur + chunk - 1n;
    try {
      await sleep(PACE_MS);
      out.push(...(await client.getLogs({ address, events, fromBlock: cur, toBlock: end })));
      cur = end + 1n;
      if (++n % 25 === 0) process.stdout.write(".");
    } catch (e) {
      if (chunk <= 100n) throw e;
      chunk /= 2n;
      process.stdout.write(`\n   (a node refused ${end - cur + 1n} blocks of logs: trying ${chunk})`);
    }
  }
  return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
}

// ---- formatting
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const num = (v, max = 2) => v.toLocaleString("en-US", { maximumFractionDigits: max });
const blockNo = (b) => num(Number(b), 0);
const coins = (wei) => {
  const v = Number(wei) / 1e18;
  return v >= 1e9 ? `${num(v / 1e9)}B` : v >= 1e6 ? `${num(v / 1e6)}M` : v >= 1e3 ? `${num(v / 1e3)}k` : num(v);
};
const price = (p) => (p === 0 ? "0" : p >= 0.001 ? num(p, 6) : p.toExponential(3));

let ltcUsd = null;
if (!args.includes("--no-usd")) {
  if (flag("usd")) ltcUsd = Number(flag("usd"));
  else {
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd", { signal: AbortSignal.timeout(8_000) });
      ltcUsd = (await r.json())?.litecoin?.usd ?? null;
    } catch {
      ltcUsd = null;
    }
  }
}

// ---- the pad
const chainId = await client.getChainId();
const head = await client.getBlockNumber();
const count = await read(launchpad, padAbi, "tokenCount");
const treasury = await read(launchpad, padAbi, "treasury");
console.log(
  `chain ${chainId} · launchpad ${launchpad} · block ${blockNo(head)} · ${count} coin${count === 1n ? "" : "s"} · treasury ${treasury}` +
    (ltcUsd ? ` · LTC $${num(ltcUsd)}` : "")
);

const list = [];
if (only) list.push(only);
else for (let i = 0n; i < count; i++) list.push(await read(launchpad, padAbi, "allTokens", [i]));
const curveOf = new Map();
for (const t of list) curveOf.set(t, await read(launchpad, padAbi, "curves", [t]));

// the pad's graduation events, once, if anything graduated
let padLogs = [];
if ([...curveOf.values()].some((c) => c[4])) {
  process.stdout.write(`reading the pad's graduations since block ${blockNo(fromBlock)}`);
  padLogs = await logs(launchpad, eventsOf(padAbi), fromBlock, head);
  console.log(` · ${padLogs.length} event${padLogs.length === 1 ? "" : "s"}`);
}

// ---- every coin
for (const token of list) {
  const [vEth, vToken, realEth, sold, graduated, creator, quoteAsset] = curveOf.get(token);
  if (vEth === 0n) {
    console.log(`\n== ${token}: not a coin of this launchpad`);
    continue;
  }
  const name = await read(token, erc20Abi, "name");
  const symbol = await read(token, erc20Abi, "symbol");
  const native = quoteAsset === ZERO;
  const qDec = native ? 18 : Number(await read(quoteAsset, erc20Abi, "decimals"));
  const qSym = native ? "native" : await read(quoteAsset, erc20Abi, "symbol");
  const isLtc = /ltc/i.test(qSym);
  const units = (amt) => Number(formatUnits(amt, qDec));
  const usd = (q) => (ltcUsd && isLtc ? ` ($${num(q * ltcUsd, q * ltcUsd >= 100 ? 0 : 2)})` : "");
  const quote = (amt) => `${num(units(amt), 4)} ${qSym}${usd(units(amt))}`;
  const mcap = (p) => `mcap ${num(p * 1e9)} ${qSym}${usd(p * 1e9)}`;
  const curvePrice = units(vEth) / (Number(vToken) / 1e18);

  console.log(`\n== ${symbol} · ${name} · ${token}`);
  console.log(`   creator ${creator} · quote ${qSym} (${qDec} decimals)`);
  if (!graduated) {
    const pct = Number((sold * 10_000n) / CURVE_SUPPLY) / 100;
    console.log(`   curve: ${pct}% · sold ${coins(sold)} · reserve ${quote(realEth)} · ${price(curvePrice)} ${qSym} per coin · ${mcap(curvePrice)}`);
    continue;
  }
  console.log(
    `   curve: graduated · sold ${coins(sold)} · closed at ${price(curvePrice)} ${qSym} per coin, ${mcap(curvePrice)} · reserve still on the pad: ${quote(realEth)}` +
      (realEth === 0n ? " (moved to the pool)" : " (NOT MIGRATED: anyone can call migrate(token))")
  );
  const mine = padLogs.filter((l) => l.args.token?.toLowerCase() === token.toLowerCase());
  for (const l of mine) {
    if (l.eventName === "Graduated") console.log(`   graduated at block ${blockNo(l.blockNumber)} · raised ${quote(l.args.raisedEth)} · tx ${l.transactionHash}`);
    if (l.eventName === "Migrated")
      console.log(`   handed to the migrator at block ${blockNo(l.blockNumber)}: ${coins(l.args.tokenAmount)} ${symbol} + ${quote(l.args.ethAmount)} (the reserve plus the liquidity pot)`);
    if (l.eventName === "AutoMigrationFailed") console.log(`   !! the automatic migration FAILED at block ${blockNo(l.blockNumber)}: the reserve stayed on the pad`);
  }
  const seedBlock = mine.find((l) => l.eventName === "Migrated")?.blockNumber ?? mine.find((l) => l.eventName === "Graduated")?.blockNumber ?? fromBlock;

  const migrator = await read(launchpad, padAbi, "graduatedVia", [token]);
  if (migrator === ZERO) {
    console.log("   no migrator recorded for this coin: the pad seeded no pool");
    continue;
  }
  const pair = await read(migrator, migratorAbi, "pairOf", [token]);
  const pairAsset = await read(migrator, migratorAbi, "pairAsset", [token]);
  if (pair === ZERO) {
    console.log(`   migrator ${migrator} knows no pool for this coin`);
    continue;
  }
  const token0 = await read(pair, pairAbi, "token0");
  const tokenIsZero = token0.toLowerCase() === token.toLowerCase();
  const sides = (a0, a1) => (tokenIsZero ? [a0, a1] : [a1, a0]);
  const [r0, r1] = await read(pair, pairAbi, "getReserves");
  const [rT, rQ] = sides(r0, r1);
  const lpTotal = await read(pair, pairAbi, "totalSupply");
  const lpOurs = await read(migrator, migratorAbi, "liquidity", [token]);
  const lockedPct = lpTotal > 0n ? Number((lpOurs * 10_000n) / lpTotal) / 100 : 0;
  const poolPrice = rT > 0n ? units(rQ) / (Number(rT) / 1e18) : 0;
  // the floor: every coin there is (the whole supply) sold into the pool, the constant product deciding what is left
  const floorQ = rT > 0n ? (rT * rQ) / TOTAL_SUPPLY : 0n;
  const floorPrice = units(floorQ) / 1e9;
  console.log(`   pool ${pair} (${tokenIsZero ? `${symbol}/${qSym}` : `${qSym}/${symbol}`}, paired with ${pairAsset}) · migrator ${migrator}`);
  console.log(
    `   pool now: ${coins(rT)} ${symbol} + ${quote(rQ)} · ${price(poolPrice)} ${qSym} per coin · ${mcap(poolPrice)} (${num((poolPrice / curvePrice - 1) * 100, 1)}% from the closing price)`
  );
  console.log(
    `   ${lockedPct}% of the pool's liquidity is the pad's, locked` +
      (lockedPct < 99.99 ? " (the rest was added by others, theirs to remove)" : "") +
      ` · floor if every one of the ${coins(TOTAL_SUPPLY)} coins were sold into it: ${quote(floorQ)} left, ${mcap(floorPrice)}`
  );
  const swept = await read(token, erc20Abi, "balanceOf", [treasury]);
  if (swept > 0n) console.log(`   the treasury holds ${coins(swept)} ${symbol}, swept at the seeding (the pool already had liquidity)`);

  // ---- what happened in the pool
  process.stdout.write(`   reading the pool since block ${blockNo(seedBlock)}`);
  const plogs = await logs(pair, eventsOf(pairAbi), seedBlock, head);
  const mlogs = (await logs(migrator, eventsOf(migratorAbi), seedBlock, seedBlock)).filter((l) => l.args.token?.toLowerCase() === token.toLowerCase());
  console.log();
  for (const l of mlogs) {
    if (l.eventName === "PoolSeeded") console.log(`   seeded: ${coins(l.args.tokenAmount)} ${symbol} + ${quote(l.args.quoteAmount)} → ${l.args.liquidity} LP`);
    if (l.eventName === "PoolRebalanced")
      console.log(`   rebalanced first (the pool held liquidity at another price): ${coins(l.args.tokenIn)} ${symbol} / ${quote(l.args.quoteIn)} traded in`);
    if (l.eventName === "PoolNudged")
      console.log(`   nudged first (the pool held dust at another price): ${coins(l.args.tokenIn)} ${symbol} / ${quote(l.args.quoteIn)} traded in`);
    if (l.eventName === "PoolParked")
      console.log(`   !! PARKED: the pool held liquidity at another price, ${coins(l.args.tokenAmount)} ${symbol} + ${quote(l.args.quoteAmount)} wait in the migrator (anyone may call seed(token) once the pool is back at the closing price)`);
  }
  const txFrom = new Map();
  const senderOf = async (hash) => {
    if (!txFrom.has(hash)) {
      await sleep(PACE_MS);
      txFrom.set(hash, (await client.getTransaction({ hash })).from);
    }
    return txFrom.get(hash);
  };
  let after = null; // (coin, quote) reserves after the last Sync, which Uniswap emits just before each Swap, Mint and Burn
  const stats = { buys: 0, buyQ: 0n, sells: 0, sellQ: 0n, adds: 0, removals: 0 };
  const rows = [["block", "what", "wallet", "amount", "pool after"]];
  for (const l of plogs) {
    const a = l.args;
    if (l.eventName === "Sync") {
      after = sides(a.reserve0, a.reserve1);
      continue;
    }
    const poolAfter = after ? `${coins(after[0])} ${symbol} + ${quote(after[1])} · ${mcap(units(after[1]) / (Number(after[0]) / 1e18))}` : "";
    const who = short(await senderOf(l.transactionHash));
    const blk = blockNo(l.blockNumber);
    if (l.eventName === "Mint") {
      stats.adds++;
      const [mT, mQ] = sides(a.amount0, a.amount1);
      const seed = a.sender.toLowerCase() === migrator.toLowerCase();
      rows.push([blk, seed ? "SEED" : "ADD", seed ? "the pad" : who, `${coins(mT)} ${symbol} + ${quote(mQ)}`, poolAfter]);
    } else if (l.eventName === "Burn") {
      stats.removals++;
      const [bT, bQ] = sides(a.amount0, a.amount1);
      rows.push([blk, "REMOVE", who, `${coins(bT)} ${symbol} + ${quote(bQ)} → ${short(a.to)}`, poolAfter]);
    } else if (l.eventName === "Swap") {
      const [tIn, qIn] = sides(a.amount0In, a.amount1In);
      const [tOut, qOut] = sides(a.amount0Out, a.amount1Out);
      const by = a.to.toLowerCase() === migrator.toLowerCase() ? "the pad (rebalance)" : a.to.toLowerCase() === launchpad.toLowerCase() ? "the pad (buyback)" : who;
      if (qIn > 0n && tOut > 0n) {
        stats.buys++;
        stats.buyQ += qIn;
        rows.push([blk, "BUY", by, `${quote(qIn)} → ${coins(tOut)} ${symbol}`, poolAfter]);
      } else if (tIn > 0n && qOut > 0n) {
        stats.sells++;
        stats.sellQ += qOut;
        rows.push([blk, "SELL", by, `${coins(tIn)} ${symbol} → ${quote(qOut)}`, poolAfter]);
      } else {
        rows.push([blk, "SWAP", by, `in ${coins(tIn)} ${symbol} + ${quote(qIn)} · out ${coins(tOut)} ${symbol} + ${quote(qOut)}`, poolAfter]);
      }
    }
  }
  console.log(
    `   since the seeding: ${stats.buys} buy${stats.buys === 1 ? "" : "s"} for ${quote(stats.buyQ)} · ${stats.sells} sell${stats.sells === 1 ? "" : "s"} for ${quote(stats.sellQ)} · ${stats.adds} liquidity add${stats.adds === 1 ? "" : "s"} · ${stats.removals} removal${stats.removals === 1 ? "" : "s"}`
  );
  const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  for (const r of rows) console.log(`     ${r.map((c, i) => c.padEnd(widths[i])).join("  ")}`);
}
