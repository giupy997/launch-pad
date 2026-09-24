// The browser's road to the Litecoin explorer. Same-origin, so the wallet
// pages need no CORS from the explorer, and the upstream can be swapped for
// another Esplora endpoint (or your own node's) with one variable.
import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_API } from "@/lib/litecoin/esplora";

export const dynamic = "force-dynamic";

const UPSTREAM = (process.env.LTC_API_UPSTREAM ?? PUBLIC_API[process.env.NEXT_PUBLIC_LTC_NETWORK === "main" ? "main" : "test"]).replace(/\/$/, "");

/** Only what the pages use: address history and coins, transactions, fees, tips. */
const ALLOWED = [
  /^blocks\/tip\/height$/,
  /^address\/[a-zA-Z0-9]{20,90}\/(utxo|txs\/mempool|txs\/chain(\/[0-9a-f]{64})?)$/,
  /^tx\/[0-9a-f]{64}(\/status)?$/,
  /^block\/[0-9a-f]{64}\/txids$/,
  /^v1\/fees\/recommended$/,
];

async function proxy(req: NextRequest, path: string[]) {
  const p = path.join("/");
  const post = req.method === "POST";
  if (post ? p !== "tx" : !ALLOWED.some((r) => r.test(p))) return NextResponse.json({ error: "not found" }, { status: 404 });
  let body: string | undefined;
  if (post) {
    body = (await req.text()).trim();
    if (!/^[0-9a-f]{20,200000}$/.test(body)) return NextResponse.json({ error: "not a raw transaction" }, { status: 400 });
  }
  try {
    const r = await fetch(`${UPSTREAM}/${p}`, {
      method: req.method,
      body,
      headers: post ? { "content-type": "text/plain" } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    return new NextResponse(await r.text(), {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") ?? "text/plain", "cache-control": "no-store" },
    });
  } catch (e) {
    return NextResponse.json({ error: `explorer unreachable: ${(e as Error).message}` }, { status: 502 });
  }
}

export function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path);
}

export function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path);
}
