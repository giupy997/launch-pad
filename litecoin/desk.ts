// Notus on Litecoin — the desk, as one long-running process for a server.
//
// Every minute: sync the explorer, replay the ledger, write the snapshot;
// every other pass, pay what is due. Meanwhile it serves the snapshot over
// HTTP so the website can read it live (Netlify: LTC_STATE_URL=https://<host>/state.json).
// Only the snapshot is exposed — read-only, no key, no wallet — and the desk
// key stays on this machine (see key.ts for where).
//
//   node litecoin/desk.ts
//
// Environment: PORT (default 8787), NOTUS_LTC_INDEX_EVERY (seconds, 60),
// NOTUS_LTC_PAYOUT_EVERY (passes between payout rounds, 2; 0 = never pay —
// run payout.ts by hand), plus everything indexer.ts and payout.ts take.
//
// A stop signal (systemctl restart) waits for the pass in progress: a payout
// round is never cut in half.
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { STATE_PATH, pass } from "./indexer.ts";
import { payDue, payoutStatus } from "./payout.ts";

const PORT = Number(process.env.PORT ?? 8787);
const EVERY = Math.max(15, Number(process.env.NOTUS_LTC_INDEX_EVERY ?? 60)) * 1000;
const PAY_EVERY = Number(process.env.NOTUS_LTC_PAYOUT_EVERY ?? 2);
/** How long a stop waits for a pass to finish before giving up on it. */
const STOP_GRACE_MS = 150_000;

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[${stamp()}] ${line}`);

let ticks = 0;
let busy = false;
let stopping = false;
let lastError: string | null = null;
let failures = 0;

async function tick() {
  if (busy || stopping) return; // a slow explorer must not pile passes up; a stopping desk starts nothing new
  busy = true;
  try {
    await pass(true);
    lastError = null;
    failures = 0;
    ticks++;
    if (PAY_EVERY > 0 && ticks % PAY_EVERY === 0 && !stopping) {
      const n = await payDue(false, log);
      if (n) log(`paid ${n} payout(s)`);
    }
  } catch (e) {
    // the first line, every URL cut to its host: a node's key never shows in /health
    lastError = (e as Error).message.split("\n")[0].replace(/https?:\/\/[^\s"'<>)]+/g, (u) => {
      try {
        return `https://${new URL(u).host}/…`;
      } catch {
        return "https://…";
      }
    });
    failures++;
    log(`pass failed: ${lastError}`);
  } finally {
    busy = false;
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "no-store");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  if (path === "/state.json" || path === "/litecoin/state.json") {
    try {
      const body = readFileSync(STATE_PATH);
      res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "no snapshot yet" }));
    }
    return;
  }
  if (path === "/health" || path === "/") {
    let updatedAt: number | null = null;
    try {
      updatedAt = Math.floor(statSync(STATE_PATH).mtimeMs / 1000);
    } catch {}
    const age = updatedAt ? Math.floor(Date.now() / 1000) - updatedAt : null;
    const payouts = payoutStatus();
    // fresh snapshot, nothing given up or unpayable, solvent as far as the last round could tell
    const ok = age !== null && age < (EVERY / 1000) * 5 && payouts.dead === 0 && payouts.unpayable === 0 && payouts.solvent !== false;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, updatedAt, ageSeconds: age, lastError, failures, passes: ticks, payouts, stopping }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
});

// loopback only: Caddy proxies it, nobody else reaches the health details
server.listen(PORT, "127.0.0.1", () => log(`desk serving ${STATE_PATH} on 127.0.0.1:${PORT} · indexing every ${EVERY / 1000}s · payouts every ${PAY_EVERY || "∞"} passes`));
void tick();
const timer = setInterval(tick, EVERY);

async function stop(sig: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log(`${sig}: stopping${busy ? ", waiting for the pass in progress" : ""}`);
  const deadline = Date.now() + STOP_GRACE_MS;
  while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (busy) log("pass still running after the grace period: exiting anyway (intents on disk make this safe)");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop(sig));
