// Who is owed holder cashback on a coin, and how much: every address that
// ever held the coin (from its Transfer logs: a holder who sold everything
// keeps what accrued while they held), read against the pad's cashbackOf.
// Read-only: it sends nothing. script/ops/cashback.sh runs it and, on a pad
// that has claimCashbackFor, sends the push.
//
//   node script/cashback.mjs --rpc url[,url] --launchpad 0x... --token 0x... --from-block <the pad's deploy block, or the coin's> \
//     [--min <quote, e.g. 0.001>] [--out holders.txt] [--top 20] [--chunk 50000] [--pace 120]
//   --rpc may be left out when SRC_RPC is in the environment (a keyed URL stays off the command line);
//   --min leaves out of the list (--out) the wallets owed less than that much quote;
//   --out writes the wallets a push would pay, one address a line: owed at least --min and
//   not a contract (claimCashbackFor passes a contract over: it claims for itself; a wallet
//   that delegated, EIP-7702, is a wallet).
//
// A range of logs the node refuses is retried once, then halved; a node's URL
// is never printed, its host alone.
import fs from "node:fs";
import { createPublicClient, fallback, http, getAddress, parseAbi, formatUnits, parseUnits } from "../../web/node_modules/viem/_esm/index.js";

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
const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return "node";
  }
};
const scrub = (s) => String(s).replace(/https?:\/\/[^\s"'<>)]+/g, (u) => `https://${host(u)}/…`);
process.on("unhandledRejection", (e) => {
  console.error(`\ncashback report failed: ${scrub(e?.shortMessage ?? e?.message ?? e).slice(0, 300)}`);
  process.exit(1);
});

const rpcs = (flag("rpc") ?? process.env.SRC_RPC ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!rpcs.length) throw new Error("--rpc is required (or SRC_RPC in the environment)");
const pad = getAddress(need("launchpad"));
const token = getAddress(need("token"));
const fromBlock = BigInt(need("from-block"));
const out = flag("out");
const PACE_MS = Number(flag("pace", "120"));
const ZERO = "0x0000000000000000000000000000000000000000";
const NATIVE_SYMBOL = { 8453: "ETH", 4441: "zkLTC", 31337: "ETH" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = createPublicClient({
  transport: fallback(rpcs.map((u) => http(u, { timeout: 30_000, batch: { batchSize: 40, wait: 16 } }))),
});
const abi = parseAbi([
  "function curves(address) view returns (uint256 vEth, uint256 vToken, uint256 realEth, uint256 sold, bool graduated, address creator, address quoteAsset)",
  "function cashbackOf(address token, address holder) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event CashbackClaimed(address indexed token, address indexed holder, uint256 amount)",
]);
const transferEvent = abi.find((x) => x.name === "Transfer");
const claimedEvent = abi.find((x) => x.name === "CashbackClaimed");

const curve = await client.readContract({ address: pad, abi, functionName: "curves", args: [token] });
if (curve[0] === 0n) throw new Error(`${token} is not a coin of the launchpad ${pad}`);
const quoteAsset = curve[6];
const [coin, quoteSymbol, quoteDecimals] = await Promise.all([
  client.readContract({ address: token, abi, functionName: "symbol" }),
  quoteAsset === ZERO ? client.getChainId().then((id) => NATIVE_SYMBOL[id] ?? "native") : client.readContract({ address: quoteAsset, abi, functionName: "symbol" }),
  quoteAsset === ZERO ? 18 : client.readContract({ address: quoteAsset, abi, functionName: "decimals" }),
]);
const min = parseUnits(flag("min", "0"), quoteDecimals);
const fmt = (v) => formatUnits(v, quoteDecimals);
const latest = await client.getBlockNumber();
console.log(`== cashback of ${coin} (${token}) on ${pad} through ${host(rpcs[0])} · blocks ${fromBlock} to ${latest}`);

// everyone who ever held the coin, and what was claimed so far
const ever = new Set();
const claimedBy = new Map();
let claimed = 0n;
let chunk = BigInt(flag("chunk", "50000"));
let retried = false;
for (let from = fromBlock; from <= latest; ) {
  const to = from + chunk - 1n > latest ? latest : from + chunk - 1n;
  try {
    await sleep(PACE_MS);
    const [transfers, claims] = await Promise.all([
      client.getLogs({ address: token, event: transferEvent, fromBlock: from, toBlock: to }),
      client.getLogs({ address: pad, event: claimedEvent, args: { token }, fromBlock: from, toBlock: to }),
    ]);
    for (const l of transfers) {
      ever.add(l.args.from);
      ever.add(l.args.to);
    }
    for (const l of claims) {
      claimed += l.args.amount;
      claimedBy.set(l.args.holder, (claimedBy.get(l.args.holder) ?? 0n) + l.args.amount);
    }
    from = to + 1n;
    retried = false;
  } catch (e) {
    const why = scrub(e?.details || e?.cause?.details || e?.shortMessage || e?.message || e).replace(/\s+/g, " ").slice(0, 140);
    if (!retried) {
      retried = true;
      await sleep(3_000);
    } else if (chunk > 500n) {
      chunk /= 2n;
      retried = false;
      console.log(`   (the node refused ${to - from + 1n} blocks of logs: ${why}; ${chunk} blocks a call from here)`);
    } else {
      throw new Error(`the node serves no logs for blocks ${from} to ${to}: ${why}`);
    }
  }
}
ever.delete(ZERO);
const addrs = [...ever];

// what each can claim now, and which of them a push would pay (wallets, not contracts)
const rows = [];
for (let i = 0; i < addrs.length; i += 40) {
  const part = addrs.slice(i, i + 40);
  const owed = await Promise.all(part.map((a) => client.readContract({ address: pad, abi, functionName: "cashbackOf", args: [token, a] })));
  part.forEach((a, j) => owed[j] > 0n && rows.push({ a, owed: owed[j] }));
  await sleep(PACE_MS);
}
for (let i = 0; i < rows.length; i += 40) {
  const part = rows.slice(i, i + 40);
  const codes = await Promise.all(part.map((r) => client.getCode({ address: r.a })));
  part.forEach((r, j) => {
    const code = codes[j] && codes[j] !== "0x" ? codes[j].toLowerCase() : "";
    // an EIP-7702 delegation (0xef0100 and an address, 23 bytes) is a wallet: the pad pays it
    r.delegated = code.length === 48 && code.startsWith("0xef0100");
    r.contract = code !== "" && !r.delegated;
  });
  await sleep(PACE_MS);
}
rows.sort((x, y) => (y.owed > x.owed ? 1 : y.owed < x.owed ? -1 : 0));
const sum = (list) => list.reduce((s, r) => s + r.owed, 0n);
const pushable = rows.filter((r) => !r.contract && r.owed >= min);
const contracts = rows.filter((r) => r.contract);
const small = rows.filter((r) => !r.contract && r.owed < min);

console.log(`   ${addrs.length} addresses ever held it; ${claimedBy.size} wallets claimed ${fmt(claimed)} ${quoteSymbol} so far`);
console.log(`   unclaimed now: ${fmt(sum(rows))} ${quoteSymbol} across ${rows.length} addresses`);
console.log(`   a push would pay ${fmt(sum(pushable))} ${quoteSymbol} to ${pushable.length} wallets (${pushable.filter((r) => r.delegated).length} of them delegated, EIP-7702)`);
if (contracts.length) console.log(`   ${contracts.length} contracts are owed ${fmt(sum(contracts))} ${quoteSymbol}: a push passes them over, they claim for themselves`);
if (small.length) console.log(`   ${small.length} wallets are owed less than ${flag("min")} ${quoteSymbol} (${fmt(sum(small))} in all): left out`);
for (const r of rows.slice(0, Number(flag("top", "20")))) {
  const before = claimedBy.get(r.a);
  console.log(`     ${r.a}  ${fmt(r.owed).padStart(14)}${r.contract ? "  contract" : ""}${before ? `  (claimed ${fmt(before)} before)` : ""}`);
}
if (rows.length > Number(flag("top", "20"))) console.log(`     … and ${rows.length - Number(flag("top", "20"))} more (--top N shows more)`);
if (out) {
  fs.writeFileSync(out, pushable.map((r) => r.a).join("\n") + (pushable.length ? "\n" : ""));
  console.log(`   ${pushable.length} addresses written to ${out}`);
}
