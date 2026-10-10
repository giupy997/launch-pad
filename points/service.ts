// Notus points — the service, as one long-running process for a server.
//
// For every chain it is configured for: every few seconds, read the pad's
// new logs, keep them, recompute the season's ledger; meanwhile answer the
// leaderboard, a wallet's points and an invite's acceptance over HTTP, for
// the website to read through its /api/points route (Netlify:
// POINTS_URL=https://<host>/points). Read-only but for the referral
// bindings, which the invitee's own signature authorises. No key here.
//
//   node points/service.ts
//
// Environment: PORT (default 8789), NOTUS_POINTS_CHAINS (comma-separated keys
// of web/lib/points/chains.ts, default "liteforge"), NOTUS_POINTS_DATA (a
// directory, default points/data), NOTUS_POINTS_EVERY (seconds between
// passes, default 10).
//
// The logic lives in web/lib/points/, so it resolves viem from the site's
// node_modules and the site reuses the same rules and the same referral
// message.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { POINTS_CHAINS } from "../web/lib/points/chains.ts";
import { ChainIndexer } from "../web/lib/points/indexer.ts";
import { Nodes } from "../web/lib/points/scan.ts";
import { Store } from "../web/lib/points/store.ts";

const PORT = Number(process.env.PORT ?? 8789);
const EVERY = Math.max(3, Number(process.env.NOTUS_POINTS_EVERY ?? 10)) * 1000;
const DATA = process.env.NOTUS_POINTS_DATA ?? join(process.cwd(), "points", "data");
const KEYS = (process.env.NOTUS_POINTS_CHAINS ?? "liteforge")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[${stamp()}] ${line}`);

const indexers = new Map<string, ChainIndexer>();
for (const key of KEYS) {
  const chain = POINTS_CHAINS[key];
  if (!chain) {
    console.error(`unknown chain "${key}" (known: ${Object.keys(POINTS_CHAINS).join(", ")})`);
    process.exit(1);
  }
  const store = new Store(join(DATA, key));
  // the chunk a refusal taught is kept with the chain's data, so a restart starts there
  const learned = store.readMeta()?.chunk;
  const nodes = new Nodes(chain.rpcs, learned !== undefined && learned < chain.chunk ? learned : chain.chunk, {
    onChunk: (size) => log(`${key}: nodes take ${size} blocks per getLogs`),
  });
  const ix = new ChainIndexer(chain, nodes, store);
  indexers.set(key, ix);
  log(`${key}: ${ix.trades.length} trades, ${ix.coins.size} coins, ${ix.referrals.size} invites on disk · indexed to ${ix.last} · season ${chain.season ? chain.season.number : "none"}`);
}

let busy = false;
let stopping = false;

async function tick() {
  if (busy || stopping) return;
  busy = true;
  try {
    for (const [key, ix] of indexers) {
      if (stopping) break;
      try {
        const r = await ix.pass();
        if (r) log(`${key}: blocks ${r.from}…${r.to}, ${r.events} events · ${ix.trades.length} trades · ${ix.totals.size} wallets scored`);
      } catch (e) {
        log(`${key}: pass failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  } finally {
    busy = false;
  }
}

// --------------------------------------------------------------- HTTP
const CACHE_GET = "public, max-age=30, s-maxage=30, stale-while-revalidate=120";
const json = (res: ServerResponse, status: number, body: unknown, cache = false, head = false) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": cache && status === 200 ? CACHE_GET : "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(head ? undefined : text);
};

// POSTs are rare and cheap to abuse: a handful per minute per address
const posts = new Map<string, number[]>();
function allowPost(ip: string): boolean {
  const now = Date.now();
  const recent = (posts.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return false;
  recent.push(now);
  posts.set(ip, recent);
  return true;
}
function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "?").trim();
}
function readBody(req: IncomingMessage, limit = 4_096): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

const ROUTE = /^\/([a-z0-9-]+)\/(season|leaderboard|referral|wallet\/(0x[0-9a-fA-F]{40}))\/?$/;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }
  if (path === "/health" || path === "/") {
    const chains: Record<string, unknown> = {};
    let ok = true;
    for (const [key, ix] of indexers) {
      const age = ix.updatedAt ? Math.floor(Date.now() / 1000) - ix.updatedAt : null;
      const fresh = ix.passes > 0 && ix.lastError === null;
      ok &&= fresh;
      chains[key] = { last: ix.last.toString(), head: ix.head.toString(), ageSeconds: age, trades: ix.trades.length, wallets: ix.totals.size, referrals: ix.referrals.size, lastError: ix.lastError };
    }
    json(res, ok ? 200 : 503, { ok, chains, stopping });
    return;
  }
  const m = path.match(ROUTE);
  if (!m) {
    json(res, 404, { error: "not found" });
    return;
  }
  const ix = indexers.get(m[1]);
  if (!ix) {
    json(res, 404, { error: "unknown chain", chains: [...indexers.keys()] });
    return;
  }
  const what = m[2];
  if (what === "referral") {
    if (req.method !== "POST") {
      json(res, 405, { error: "POST an invite acceptance here" });
      return;
    }
    if (!allowPost(clientIp(req))) {
      json(res, 429, { error: "too many requests" });
      return;
    }
    const raw = await readBody(req);
    let claim: { invitee?: unknown; inviter?: unknown; signature?: unknown } = {};
    try {
      claim = raw ? (JSON.parse(raw) as typeof claim) : {};
    } catch {
      json(res, 400, { error: "not JSON" });
      return;
    }
    if (typeof claim.invitee !== "string" || typeof claim.inviter !== "string" || typeof claim.signature !== "string") {
      json(res, 400, { error: "invitee, inviter and signature are needed" });
      return;
    }
    const r = await ix.bindReferral({ invitee: claim.invitee, inviter: claim.inviter, signature: claim.signature });
    json(res, r.status, r.body);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  const head = req.method === "HEAD";
  if (what === "season") {
    json(res, 200, ix.season(), true, head);
    return;
  }
  if (what === "leaderboard") {
    const limit = Number(url.searchParams.get("limit") ?? 100);
    json(res, 200, { season: ix.season().season, updatedAt: ix.updatedAt, rows: ix.leaderboard(Number.isFinite(limit) ? limit : 100) }, true, head);
    return;
  }
  if (what.startsWith("wallet/")) {
    json(res, 200, ix.wallet(m[3]), true, head);
    return;
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => log(`points serving ${[...indexers.keys()].join(", ")} on 127.0.0.1:${PORT} · a pass every ${EVERY / 1000}s · data in ${DATA}`));
void tick();
const timer = setInterval(tick, EVERY);

async function stop(sig: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log(`${sig}: stopping${busy ? ", waiting for the pass in progress" : ""}`);
  const deadline = Date.now() + 60_000;
  while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop(sig));
