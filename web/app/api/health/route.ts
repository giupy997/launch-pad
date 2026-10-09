import { NextResponse } from "next/server";
import { getStore } from "@netlify/blobs";
import { POINTS_CHAINS } from "@/lib/points/chains";
import { latestBlock, redact } from "@/lib/trades/scan";

export const dynamic = "force-dynamic";

// One answer for an uptime monitor: 200 when the parts the site stands on
// answer (Base's nodes, the Blobs store the holder counts live in), 503 with
// the part that does not. The testnet's nodes and the points service are
// reported too but do not decide the status: an outage there is not an outage
// of the site. Every check is given a few seconds, so a node that hangs never
// holds the answer past the function's time.

const CHECK_MS = 6_000;
const VITAL = new Set(["rpc:base", "blobs"]);

type Check = { ok: boolean; ms: number; note: string };

async function timed(fn: () => Promise<string>): Promise<Check> {
  const t0 = Date.now();
  try {
    const note = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer in ${CHECK_MS / 1000}s`)), CHECK_MS)),
    ]);
    return { ok: true, ms: Date.now() - t0, note };
  } catch (e) {
    // the message's first line, URLs cut to their host: a keyed node's key never leaves here
    return { ok: false, ms: Date.now() - t0, note: redact(e instanceof Error ? e.message.split("\n")[0] : String(e)).slice(0, 160) };
  }
}

export async function GET() {
  const started = Date.now();
  const names: string[] = [];
  const runs: Promise<Check>[] = [];
  for (const c of Object.values(POINTS_CHAINS)) {
    names.push(`rpc:${c.key}`);
    // two seconds a node, so one that hangs does not fail the check while the others answer
    runs.push(timed(async () => `block ${await latestBlock({ chainId: c.chainId, urls: c.rpcs, chunk: c.chunk }, 2_000, Date.now() + CHECK_MS - 500)}`));
  }
  names.push("blobs");
  runs.push(
    timed(async () => {
      // a read of a key that does not exist: the store answers null when it is there at all
      await getStore({ name: "holders", consistency: "strong" }).get("health-probe");
      return "reachable";
    })
  );
  const points = process.env.POINTS_URL?.replace(/\/$/, "");
  if (points) {
    names.push("points");
    runs.push(
      timed(async () => {
        const r = await fetch(`${points}/health`, { cache: "no-store", signal: AbortSignal.timeout(CHECK_MS - 500) });
        if (!r.ok) throw new Error(`http ${r.status}`);
        return `http ${r.status}`;
      })
    );
  }
  const results = await Promise.all(runs);
  const checks = Object.fromEntries(names.map((n, i) => [n, results[i]]));
  const failing = names.filter((n) => !checks[n].ok);
  const ok = failing.every((n) => !VITAL.has(n));
  return NextResponse.json(
    { ok, status: ok ? (failing.length ? "degraded" : "up") : "down", failing, checks, ms: Date.now() - started },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
