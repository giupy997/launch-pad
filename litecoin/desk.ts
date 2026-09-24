// Notus on Litecoin — the desk, as one long-running process for a server.
//
// Every minute: sync the explorer, replay the ledger, write the snapshot;
// every other pass, pay what is due. Meanwhile it serves the snapshot over
// HTTP so the website can read it live (Netlify: LTC_STATE_URL=https://<host>/state.json).
// Only the snapshot is exposed — read-only, no key, no wallet — and the desk
// key stays in litecoin/desk/key.json (or NOTUS_LTC_DESK_KEY) on this machine.
//
//   node litecoin/desk.ts
//
// Environment: PORT (default 8787), NOTUS_LTC_INDEX_EVERY (seconds, 60),
// NOTUS_LTC_PAYOUT_EVERY (passes between payout rounds, 2; 0 = never pay —
// run payout.ts by hand), plus everything indexer.ts and payout.ts take.
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { STATE_PATH, pass } from "./indexer.ts";
import { payDue } from "./payout.ts";

const PORT = Number(process.env.PORT ?? 8787);
const EVERY = Math.max(15, Number(process.env.NOTUS_LTC_INDEX_EVERY ?? 60)) * 1000;
const PAY_EVERY = Number(process.env.NOTUS_LTC_PAYOUT_EVERY ?? 2);

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[${stamp()}] ${line}`);

let ticks = 0;
let busy = false;
let lastError: string | null = null;

async function tick() {
  if (busy) return; // a slow explorer must not pile passes up
  busy = true;
  try {
    await pass(true);
    lastError = null;
    ticks++;
    if (PAY_EVERY > 0 && ticks % PAY_EVERY === 0) {
      const n = await payDue(false, log);
      if (n) log(`paid ${n} payout(s)`);
    }
  } catch (e) {
    lastError = (e as Error).message.split("\n")[0];
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
    const ok = age !== null && age < (EVERY / 1000) * 5;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, updatedAt, ageSeconds: age, lastError, passes: ticks }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => log(`desk serving ${STATE_PATH} on :${PORT} · indexing every ${EVERY / 1000}s · payouts every ${PAY_EVERY || "∞"} passes`));
void tick();
setInterval(tick, EVERY);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => server.close(() => process.exit(0)));
