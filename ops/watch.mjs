#!/usr/bin/env node
// The watch: one process on the VPS that tells the owner, on Telegram, of
// anything that could move the launchpad's money or change who controls it,
// and that the site still points at the right contracts.
//
// What it reads, once a minute, from Base:
//   - the timelocks (v12 and v11): every operation scheduled, executed or
//     cancelled, decoded to the function it calls (a migrateOut, a
//     setTreasury, a grantRole…), with the time it becomes executable; every
//     role granted or revoked; a change of the delay. An operation nobody
//     knows of is the one way the pad's cbLTC can leave: the 24-hour delay is
//     worth exactly as much as the chance of seeing it in time.
//   - the pads (v12 and v11): the owner-only events as a second signal
//     (treasury, fee, migrator, quote, operator, freeze, migrateOut, pool
//     registered, ownership), which only land when such an operation runs.
// And, every ten minutes, the site: /api/health answers, the homepage's
// scripts still carry the pad's address (a deploy that swapped it would be
// the classic frontend hack), and a new deploy is reported when the
// scripts change. Once a day a heartbeat says it is alive, with what is
// pending. An operation that becomes executable is reported once more.
//
//   cd ~/launch-pad && node ops/watch.mjs                 # the service (ops/deploy/notus-watch.service)
//   node ops/watch.mjs --dry --once                       # one pass, printed, nothing sent
//
// Environment (ops/deploy/watch.env.example): TG_BOT_TOKEN and TG_CHAT_ID
// (Telegram; required unless --dry), NOTUS_WATCH_RPC (Base nodes, comma-
// separated, a keyed one first), NOTUS_WATCH_TIMELOCKS / NOTUS_WATCH_PADS
// ("0xaddr=label,…", default the Base v12 and v11 stacks),
// NOTUS_WATCH_SITE (default https://notus-pad.fun; empty skips the site),
// NOTUS_WATCH_SITE_PAD (the address the site must carry), NOTUS_WATCH_STATE
// (the state file, default ops/state/watch.json), NOTUS_WATCH_EVERY (seconds,
// 60), NOTUS_WATCH_SITE_EVERY (600), NOTUS_WATCH_CHUNK (blocks a call, 1500;
// 9000 on a keyed node), NOTUS_WATCH_FROM (the block the first run starts
// from; default the v11 timelock's deploy block, summarised in one message),
// NOTUS_WATCH_HEARTBEAT_HOUR (UTC hour of the daily heartbeat, 8).
// No key, no wallet: it only reads. Needs web/'s node_modules (viem).
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  http,
  fallback,
  parseAbi,
  decodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  formatUnits,
} from "../web/node_modules/viem/_esm/index.js";
import { base } from "../web/node_modules/viem/_esm/chains/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = new Set(process.argv.slice(2));
const DRY = argv.has("--dry");
const ONCE = argv.has("--once");

// ---------------------------------------------------------------- settings

const env = (name, fallbackValue) => (process.env[name] === undefined || process.env[name] === "" ? fallbackValue : process.env[name]);
const list = (raw) =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [addr, ...label] = s.split("=");
      if (!isAddress(addr)) throw new Error(`not an address: ${addr}`);
      return { address: getAddress(addr), label: label.join("=") || addr };
    });

const RPCS = env("NOTUS_WATCH_RPC", "https://mainnet.base.org,https://base-rpc.publicnode.com,https://base.drpc.org")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TIMELOCKS = list(env("NOTUS_WATCH_TIMELOCKS", "0xe28f446D3a1DB105F8F9b34A65474E1F6d256f76=timelock v12,0xeDCe189855E9298C3f5b937fE9Ffe8D5261B9EB2=timelock v11"));
const PADS = list(env("NOTUS_WATCH_PADS", "0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5=Launchpad v12,0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4=Launchpad v11"));
// names for the addresses that show up in operations, so a message reads "treasury", not a hash
const NAMES = new Map(
  list(
    env(
      "NOTUS_WATCH_NAMES",
      "0x6f3303c520dE1a74a664c3EB3045cfb0380d40B3=UniV2Migrator v3,0xaB950946E55Fbe4685F293924fA83529b5fDfEf1=UniV2Migrator v4,0x0F413C63Cfeb342Bcd1ae176DE896b530e02B2a2=migration module v12,0x15045E01b6A38f40695EEa0BB31aE0342f7Ee810=zap v12,0x24622320D93Da2d9c626EE469ad0C2c48a1ED7F7=treasury,0x707f56C25e5d8cc12d08A3bf73f54dBeD0CD9A02=dev wallet,0xcb17C9Db87B595717C857a08468793f5bAb6445F=cbLTC,0x8fB7f1D18F4b2ECC79da94aBF51f95B93E07d218=UniV2Migrator v2,0x934A82649b4ca538ff47d9090536837B7092d8F4=Safe 2/3 (notus)"
    )
  ).map((n) => [n.address.toLowerCase(), n.label])
);
for (const t of TIMELOCKS) NAMES.set(t.address.toLowerCase(), t.label);
for (const p of PADS) NAMES.set(p.address.toLowerCase(), p.label);
// set to "" (NOTUS_WATCH_SITE=) the site is not watched
const SITE = (process.env.NOTUS_WATCH_SITE ?? "https://notus-pad.fun").replace(/\/$/, "");
const SITE_PAD = env("NOTUS_WATCH_SITE_PAD", "0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5").toLowerCase();
const STATE_FILE = path.resolve(ROOT, env("NOTUS_WATCH_STATE", "ops/state/watch.json"));
const EVERY_MS = Number(env("NOTUS_WATCH_EVERY", "60")) * 1000;
const SITE_EVERY_MS = Number(env("NOTUS_WATCH_SITE_EVERY", "600")) * 1000;
const CHUNK = BigInt(env("NOTUS_WATCH_CHUNK", "1500"));
const FIRST_BLOCK = BigInt(env("NOTUS_WATCH_FROM", "52180589")); // the v11 timelock's deploy block
const HEARTBEAT_HOUR = Number(env("NOTUS_WATCH_HEARTBEAT_HOUR", "8"));
const LAG = 3n; // blocks left to settle before they are read
const EXPLORER = env("NOTUS_WATCH_EXPLORER", "https://basescan.org");
const TG_TOKEN = process.env.TG_BOT_TOKEN ?? "";
const TG_CHAT = process.env.TG_CHAT_ID ?? "";
if (!DRY && (!TG_TOKEN || !TG_CHAT)) {
  console.error("TG_BOT_TOKEN and TG_CHAT_ID are not set (ops/deploy/watch.env.example); --dry prints instead of sending");
  process.exit(1);
}

// ---------------------------------------------------------------- the chain

const client = createPublicClient({
  chain: base,
  transport: fallback(
    RPCS.map((url) => http(url, { timeout: 15_000, retryCount: 1 })),
    { rank: false }
  ),
});

const TIMELOCK_EVENTS = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
]);
const PAD_EVENTS = parseAbi([
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
  "event TreasuryUpdated(address treasury)",
  "event FeeUpdated(uint256 feeBps)",
  "event MigratorUpdated(address migrator)",
  "event QuoteAssetUpdated(address indexed asset, uint256 virtualReserve)",
  "event MigrationOperatorUpdated(address operator)",
  "event FreezeAnnounced(uint256 freezeBlock)",
  "event FreezeCancelled()",
  "event MigratedOut(address indexed token, address indexed to, uint256 quoteAmount, uint256 tokensBurned)",
  "event MigrationClosed()",
  "event MigrationRootSet(bytes32 root, uint256 freezeHeight)",
  "event PoolRegistered(address indexed token, address indexed pool)",
]);
// what a scheduled operation may call: the pads' owner functions (v11 and v12, the
// migration module's included) and the timelock's own administration
const CALLS = parseAbi([
  "function setFeeBps(uint256 newFeeBps)",
  "function setTreasury(address newTreasury)",
  "function setMigrator(address newMigrator)",
  "function setQuoteAsset(address asset, uint256 virtualReserve)",
  "function setQuoteAssets(address[] assets, uint256[] virtualReserves)",
  "function setFeeSplit(uint256 newCreatorBps, uint256 newCashbackBps)",
  "function registerTaxedPool(address token, address pool)",
  "function setMigrationOperator(address operator)",
  "function setMigrationRoot(bytes32 root, uint256 freezeHeight)",
  // a migration in, when the owner runs it through the timelock: the v12 module on Base, and the
  // one after it (every coin and every holder proven against the root: SECURITY.md, H-01)
  "function migrateToken((string name, string symbol, (string logoURI, string website, string twitter, string telegram, string livestream, string description) meta, address creator, address feeRecipient, (uint16 buyTaxBps, uint16 sellTaxBps, uint16 creatorBps, uint16 holdersBps, uint16 burnBps, uint16 liquidityBps, uint16 platformBps) fees, address quoteAsset, uint256 quoteAmount, uint256 virtualQuote, uint256 sold, uint256 burned, uint256 poolToken, uint256 burnPot, uint256 liquidityPot) coin, address[] holders, uint256[] balances)",
  "function migrateToken((string name, string symbol, (string logoURI, string website, string twitter, string telegram, string livestream, string description) meta, address creator, address feeRecipient, (uint16 buyTaxBps, uint16 sellTaxBps, uint16 creatorBps, uint16 holdersBps, uint16 burnBps, uint16 liquidityBps, uint16 platformBps) fees, address quoteAsset, uint256 quoteAmount, uint256 virtualQuote, uint256 sold, uint256 burned, uint256 poolToken, uint256 burnPot, uint256 liquidityPot) coin, bytes32[] coinProof, (address[] holders, uint256[] balances, bytes32[][] proofs) first)",
  "function migrateBalances(address token, address[] holders, uint256[] balances)",
  "function migrateBalances(address token, (address[] holders, uint256[] balances, bytes32[][] proofs) batch)",
  "function closeMigration()",
  "function announceFreeze(uint256 atBlock)",
  "function cancelFreeze()",
  "function migrateOut(address token, address to)",
  "function transferOwnership(address newOwner)",
  "function renounceOwnership()",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role, address callerConfirmation)",
  "function updateDelay(uint256 newDelay)",
]);
// the calls that move money or control: a siren, not a note
const SIREN = new Set([
  "migrateOut",
  "setTreasury",
  "setMigrator",
  "setMigrationOperator",
  "announceFreeze",
  "transferOwnership",
  "renounceOwnership",
  "grantRole",
  "revokeRole",
  "renounceRole",
  "updateDelay",
  "setMigrationRoot",
]);
const ROLES = new Map(
  ["PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"].map((r) => [keccak256(stringToHex(r)), r.replace("_ROLE", "")])
);
ROLES.set("0x0000000000000000000000000000000000000000000000000000000000000000", "ADMIN");

// ---------------------------------------------------------------- helpers

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const who = (a) => {
  const addr = isAddress(a) ? getAddress(a) : String(a);
  const l = NAMES.get(addr.toLowerCase());
  return l ? `${l} (${short(addr)})` : short(addr);
};
const calls = (p) => (p.calls.length === 1 ? p.calls[0] : p.calls.map((c) => `• ${c}`).join("\n"));
const whenUtc = (ts) => new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const hours = (secs) => (Number(secs) / 3600).toFixed(Number(secs) % 3600 === 0 ? 0 : 1);
const txLink = (hash) => `${EXPLORER}/tx/${hash}`;
const log = (...a) => console.log(new Date().toISOString(), ...a);

/** A scheduled call, in words: "Launchpad v12 → setTreasury(treasury (0x2462…D7F7))". */
function describeCall(target, data, value) {
  let text;
  try {
    const { functionName, args = [] } = decodeFunctionData({ abi: CALLS, data });
    const shown = args.map((x, i) => {
      if (functionName === "grantRole" || functionName === "revokeRole" || functionName === "renounceRole") {
        if (i === 0) return ROLES.get(x) ?? String(x);
      }
      if (typeof x === "string" && isAddress(x)) return who(x);
      if (typeof x === "bigint") return x.toString();
      if (Array.isArray(x)) return `[${x.map((y) => (typeof y === "string" && isAddress(y) ? who(y) : String(y))).join(", ")}]`;
      return String(x);
    });
    text = `${functionName}(${shown.join(", ")})`;
    return { text: `${who(target)} → ${text}`, fn: functionName, siren: SIREN.has(functionName) };
  } catch {
    const sel = data.slice(0, 10);
    return { text: `${who(target)} → chiamata sconosciuta ${sel} (${(data.length - 2) / 2} byte)${value ? `, ${formatUnits(value, 18)} ETH` : ""}`, fn: sel, siren: true };
  }
}

// ---------------------------------------------------------------- telegram

const outbox = [];
async function send(text) {
  log("message:", text.replace(/\n/g, " | "));
  if (DRY) return;
  outbox.push(text);
  await flush();
}
let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (outbox.length) {
      const text = outbox[0];
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      }).catch((e) => ({ ok: false, status: 0, json: async () => ({ description: String(e.message ?? e) }) }));
      if (r.ok) {
        outbox.shift();
        continue;
      }
      const body = await r.json().catch(() => ({}));
      if (r.status === 429) {
        const wait = Number(body?.parameters?.retry_after ?? 5);
        log(`telegram: rate limited, ${wait}s`);
        await new Promise((res) => setTimeout(res, wait * 1000));
        continue;
      }
      log(`telegram: not sent (http ${r.status}: ${body?.description ?? "?"}); kept for the next pass`);
      break;
    }
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------- state

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { pending: {}, siteFails: 0, padMissing: 0, ...s };
  } catch {
    return { lastBlock: null, pending: {}, siteFails: 0, padMissing: 0, fingerprint: null, lastHeartbeat: null };
  }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------- the chain pass

/** Logs of the timelocks and the pads from `from` to `to`, in order. */
async function readLogs(from, to) {
  const out = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = a + CHUNK - 1n < to ? a + CHUNK - 1n : to;
    const [tl, pads] = await Promise.all([
      client.getLogs({ address: TIMELOCKS.map((t) => t.address), events: TIMELOCK_EVENTS, fromBlock: a, toBlock: b }),
      client.getLogs({ address: PADS.map((p) => p.address), events: PAD_EVENTS, fromBlock: a, toBlock: b }),
    ]);
    out.push(...tl, ...pads);
  }
  out.sort((x, y) => (x.blockNumber === y.blockNumber ? Number(x.logIndex) - Number(y.logIndex) : x.blockNumber < y.blockNumber ? -1 : 1));
  return out;
}

const blockTimes = new Map();
async function blockTime(n) {
  if (!blockTimes.has(n)) blockTimes.set(n, (await client.getBlock({ blockNumber: n })).timestamp);
  return blockTimes.get(n);
}

/** One log → a message (or null) and a change of the pending map. `quiet`: the
 *  first run's catch-up, which only fills the pending map. */
async function handle(l, state, quiet) {
  const at = who(l.address);
  const a = l.args;
  switch (l.eventName) {
    // a batch is one operation with several calls: one CallScheduled (and one
    // CallExecuted) per call, the same id, the same transaction; grouped into one message
    case "CallScheduled": {
      const d = describeCall(a.target, a.data, a.value);
      const ts = await blockTime(l.blockNumber);
      const readyAt = Number(ts + a.delay);
      const p = state.pending[a.id];
      if (p && p.tx === l.transactionHash) {
        p.calls.push(d.text);
        p.siren ||= d.siren;
      } else state.pending[a.id] = { calls: [d.text], readyAt, timelock: at, reminded: false, siren: d.siren, tx: l.transactionHash };
      if (quiet) return null;
      return { kind: "scheduled", id: a.id, at, calls: [d.text], siren: d.siren, readyAt, delay: a.delay, tx: l.transactionHash };
    }
    case "CallExecuted": {
      const d = describeCall(a.target, a.data, a.value);
      delete state.pending[a.id];
      if (quiet) return null;
      return { kind: "executed", id: a.id, at, calls: [d.text], siren: d.siren, tx: l.transactionHash };
    }
    case "Cancelled": {
      const p = state.pending[a.id];
      delete state.pending[a.id];
      if (quiet) return null;
      return `🛑 ${at}: operazione ANNULLATA\n${p ? calls(p) : `id ${a.id}`}\n${txLink(l.transactionHash)}`;
    }
    case "MinDelayChange":
      return quiet ? null : `🚨 ${at}: il ritardo passa da ${hours(a.oldDuration)} h a ${hours(a.newDuration)} h\n${txLink(l.transactionHash)}`;
    case "RoleGranted":
      return quiet ? null : `🚨 ${at}: ruolo ${ROLES.get(a.role) ?? a.role} CONCESSO a ${who(a.account)} (da ${who(a.sender)})\n${txLink(l.transactionHash)}`;
    case "RoleRevoked":
      return quiet ? null : `🚨 ${at}: ruolo ${ROLES.get(a.role) ?? a.role} REVOCATO a ${who(a.account)} (da ${who(a.sender)})\n${txLink(l.transactionHash)}`;
    // the pads: a second signal of what the timelock (or an operator) did
    case "OwnershipTransferred":
      return quiet ? null : `🚨 ${at}: PROPRIETARIO cambiato: ${who(a.previousOwner)} → ${who(a.newOwner)}\n${txLink(l.transactionHash)}`;
    case "TreasuryUpdated":
      return quiet ? null : `🚨 ${at}: treasury ora ${who(a.treasury)}\n${txLink(l.transactionHash)}`;
    case "MigratorUpdated":
      return quiet ? null : `🚨 ${at}: migrator ora ${who(a.migrator)}\n${txLink(l.transactionHash)}`;
    case "MigrationOperatorUpdated":
      return quiet ? null : `🚨 ${at}: operatore di migrazione ora ${who(a.operator)}\n${txLink(l.transactionHash)}`;
    case "FreezeAnnounced":
      return quiet ? null : `🚨 ${at}: FREEZE annunciato al blocco ${a.freezeBlock}\n${txLink(l.transactionHash)}`;
    case "FreezeCancelled":
      return quiet ? null : `🛑 ${at}: freeze annullato\n${txLink(l.transactionHash)}`;
    case "MigratedOut":
      return quiet
        ? null
        : `🚨 ${at}: MIGRATE OUT di ${short(a.token)}: ${formatUnits(a.quoteAmount, 8)} cbLTC a ${who(a.to)}, ${formatUnits(a.tokensBurned, 18)} coin bruciati\n${txLink(l.transactionHash)}`;
    case "MigrationClosed":
      return quiet ? null : `ℹ️ ${at}: migrazione chiusa\n${txLink(l.transactionHash)}`;
    case "MigrationRootSet":
      return quiet ? null : `⚠️ ${at}: root di migrazione impostata (freeze ${a.freezeHeight})\n${txLink(l.transactionHash)}`;
    case "FeeUpdated":
      return quiet ? null : `⚠️ ${at}: fee del launchpad ora ${Number(a.feeBps) / 100}%\n${txLink(l.transactionHash)}`;
    case "QuoteAssetUpdated":
      return quiet ? null : `⚠️ ${at}: quote ${who(a.asset)} riserva virtuale ${a.virtualReserve}\n${txLink(l.transactionHash)}`;
    case "PoolRegistered":
      return quiet ? null : `⚠️ ${at}: pool ${short(a.pool)} registrato per ${short(a.token)}\n${txLink(l.transactionHash)}`;
    default:
      return null;
  }
}

/** A grouped operation, in words. */
function render(g) {
  const n = g.calls.length > 1 ? ` (${g.calls.length} chiamate)` : "";
  if (g.kind === "scheduled")
    return (
      `${g.siren ? "🚨" : "⚠️"} ${g.at}: OPERAZIONE PROGRAMMATA${n}\n${calls(g)}\n` +
      `eseguibile da ${whenUtc(g.readyAt)} (tra ${hours(g.delay)} h)\nid ${g.id}\n${txLink(g.tx)}` +
      (g.siren ? "\nSe non sei stato tu: annullala subito (cancel) prima di quell'ora." : "")
    );
  return `${g.siren ? "🚨" : "✅"} ${g.at}: operazione ESEGUITA${n}\n${calls(g)}\n${txLink(g.tx)}`;
}

async function chainPass(state) {
  const head = (await client.getBlockNumber()) - LAG;
  const first = state.lastBlock === null;
  const from = first ? FIRST_BLOCK : BigInt(state.lastBlock) + 1n;
  if (from <= head) await readPass(state, from, head, first);
  // an operation that became executable (by the chain's clock): said once more, so the
  // owner's own work is not forgotten and somebody else's is not missed
  const now = Number(await blockTime(head));
  for (const [id, p] of Object.entries(state.pending)) {
    if (!p.reminded && p.readyAt <= now) {
      p.reminded = true;
      await send(`⏰ ${p.timelock}: l'operazione è ora ESEGUIBILE da chiunque\n${calls(p)}\nid ${id}`);
    }
  }
}

async function readPass(state, from, head, first) {
  const logs = await readLogs(from, head);
  const messages = [];
  const groups = new Map();
  for (const l of logs) {
    const m = await handle(l, state, first);
    if (!m) continue;
    const order = { block: l.blockNumber, tx: l.transactionHash, index: Number(l.logIndex) };
    if (typeof m === "string") {
      messages.push({ text: m, ...order, group: false });
      continue;
    }
    const key = `${m.kind}:${m.id}:${m.tx}`;
    const g = groups.get(key);
    if (g) {
      g.calls.push(...m.calls);
      g.siren ||= m.siren;
    } else {
      groups.set(key, m);
      messages.push({ key, ...order, group: true });
    }
  }
  // within one transaction the operation comes first, then what it did
  messages.sort((x, y) =>
    x.block !== y.block ? (x.block < y.block ? -1 : 1) : x.tx !== y.tx ? x.index - y.index : x.group !== y.group ? (x.group ? -1 : 1) : x.index - y.index
  );
  state.lastBlock = head.toString();
  if (first) {
    const pend = Object.values(state.pending);
    await send(
      `👁 Notus watch avviato. Letti i blocchi ${from}–${head} di Base: ${logs.length} eventi di governance in tutto.\n` +
        `Guardo: ${TIMELOCKS.map((t) => t.label).join(", ")}; ${PADS.map((p) => p.label).join(", ")}${SITE ? `; il sito ${SITE}` : ""}.\n` +
        (pend.length ? `Operazioni in attesa: ${pend.length}\n${pend.map((p) => `• ${p.calls.join(" + ")} (eseguibile da ${whenUtc(p.readyAt)})`).join("\n")}` : "Nessuna operazione in attesa sui timelock.")
    );
  } else {
    for (const m of messages) await send(m.text ?? render(groups.get(m.key)));
  }
}

// ---------------------------------------------------------------- the site pass

async function fetchText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "notus-watch" } });
  const text = await r.text();
  return { status: r.status, text };
}

async function sitePass(state) {
  if (!SITE) return;
  const problems = [];
  let healthNote = "";
  try {
    const { status, text } = await fetchText(`${SITE}/api/health`);
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (status !== 200 || !j?.ok) problems.push(`/api/health risponde ${status}${j?.failing?.length ? `, guasti: ${j.failing.join(", ")}` : ""}`);
    healthNote = j?.status ?? `http ${status}`;
  } catch (e) {
    problems.push(`/api/health non risponde (${e.message ?? e})`);
  }
  let padFound = false;
  let fingerprint = null;
  try {
    const { status, text } = await fetchText(`${SITE}/`);
    if (status !== 200) problems.push(`la home risponde ${status}`);
    const scripts = [...text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith("/_next/static/"));
    fingerprint = createHash("sha256").update(scripts.slice().sort().join("\n")).digest("hex").slice(0, 16);
    padFound = text.toLowerCase().includes(SITE_PAD);
    for (const src of scripts.slice(0, 40)) {
      if (padFound) break;
      const { text: js } = await fetchText(`${SITE}${src}`);
      if (js.toLowerCase().includes(SITE_PAD)) padFound = true;
    }
    if (!padFound) {
      // the config may sit in a chunk the home does not load: the Create page carries it for sure
      const { text: create } = await fetchText(`${SITE}/create`);
      const more = [...create.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((s) => s.startsWith("/_next/static/") && !scripts.includes(s));
      padFound = create.toLowerCase().includes(SITE_PAD);
      for (const src of more.slice(0, 40)) {
        if (padFound) break;
        const { text: js } = await fetchText(`${SITE}${src}`);
        if (js.toLowerCase().includes(SITE_PAD)) padFound = true;
      }
    }
  } catch (e) {
    problems.push(`la home non risponde (${e.message ?? e})`);
  }

  // a new deploy: the set of scripts changed
  if (fingerprint && state.fingerprint && fingerprint !== state.fingerprint) {
    await send(`📦 Il sito è cambiato (nuovo deploy): ${fingerprint}. Se non hai pubblicato tu, controlla Netlify e GitHub adesso.`);
  }
  if (fingerprint) state.fingerprint = fingerprint;

  // the pad's address, missing twice in a row: the one thing a hostile deploy would change
  if (fingerprint && !padFound) {
    state.padMissing += 1;
    if (state.padMissing === 2) await send(`🚨 IL SITO NON CONTIENE PIÙ L'INDIRIZZO DEL PAD ${short(SITE_PAD)}: un deploy può aver cambiato i contratti a cui manda i soldi. Blocca i deploy su Netlify e controlla GitHub.`);
  } else if (fingerprint) {
    if (state.padMissing >= 2) await send(`✅ Il sito contiene di nuovo l'indirizzo del pad ${short(SITE_PAD)}.`);
    state.padMissing = 0;
  }

  // health, failing twice in a row (a single hiccup of a public node is not news)
  if (problems.length) {
    state.siteFails += 1;
    if (state.siteFails === 2) await send(`⚠️ Sito: ${problems.join("; ")}`);
  } else {
    if (state.siteFails >= 2) await send(`✅ Sito di nuovo a posto (${healthNote}).`);
    state.siteFails = 0;
  }
  state.siteNote = problems.length ? problems.join("; ") : `ok (${healthNote})`;
  log(`site: ${state.siteNote}; pad ${padFound ? "found" : "MISSING"}; deploy ${fingerprint ?? "?"}`);
}

// ---------------------------------------------------------------- heartbeat

async function heartbeat(state) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() !== HEARTBEAT_HOUR || state.lastHeartbeat === day) return;
  state.lastHeartbeat = day;
  const pend = Object.values(state.pending);
  await send(
    `✅ Notus watch vivo. Base al blocco ${state.lastBlock}.\n` +
      (pend.length ? `Operazioni in attesa sui timelock: ${pend.length}\n${pend.map((p) => `• ${p.calls.join(" + ")} (eseguibile da ${whenUtc(p.readyAt)})`).join("\n")}` : "Nessuna operazione in attesa sui timelock.") +
      (SITE ? `\nSito: ${state.siteNote ?? "non ancora controllato"}${state.fingerprint ? `, deploy ${state.fingerprint}` : ""}.` : "")
  );
}

// ---------------------------------------------------------------- main

const state = loadState();
let lastSite = 0;
let stopping = false;
process.on("SIGTERM", () => (stopping = true));
process.on("SIGINT", () => (stopping = true));
log(`watch: ${TIMELOCKS.length} timelock, ${PADS.length} pad, site ${SITE || "(off)"}, rpc ${RPCS.map((u) => new URL(u).host).join(", ")}${DRY ? ", dry" : ""}`);
for (;;) {
  try {
    await chainPass(state);
  } catch (e) {
    log("chain pass failed:", e.shortMessage ?? e.message ?? e);
  }
  if (Date.now() - lastSite >= SITE_EVERY_MS) {
    lastSite = Date.now();
    try {
      await sitePass(state);
    } catch (e) {
      log("site pass failed:", e.message ?? e);
    }
  }
  try {
    await heartbeat(state);
  } catch (e) {
    log("heartbeat failed:", e.message ?? e);
  }
  saveState(state);
  await flush();
  if (ONCE || stopping) break;
  await new Promise((res) => setTimeout(res, EVERY_MS));
}
