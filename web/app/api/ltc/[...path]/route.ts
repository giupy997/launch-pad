// The browser's road to the Litecoin chain, in Esplora's dialect. Same-origin,
// so the wallet pages need no CORS from any explorer, and what answers is
// LTC_API_UPSTREAM: an Esplora endpoint (litecoinspace.org by default), a
// Blockbook one (…/api/v2, translated here), or several, comma separated,
// tried in order when one is down. LTC_API_KEY goes to Blockbook endpoints.
import { NextResponse, type NextRequest } from "next/server";
import { ApiError, PUBLIC_API } from "@/lib/litecoin/esplora";
import { chainApi } from "@/lib/litecoin/chain";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_LTC_NETWORK === "main" ? "main" : "test";
/** Well under the hosting function's own limit, so the browser sees the error, not a dead connection. */
const TIMEOUT_MS = 20_000;
const api = chainApi(process.env.LTC_API_UPSTREAM ?? PUBLIC_API[NETWORK], NETWORK, process.env.LTC_API_KEY, TIMEOUT_MS);

const ADDRESS = "([a-zA-Z0-9]{20,90})";
const HASH = "([0-9a-f]{64})";
const text = (body: string, status = 200) =>
  new NextResponse(body, { status, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
const json = (body: unknown) => NextResponse.json(body, { headers: { "cache-control": "no-store" } });

/** Only what the pages use: address history and coins, transactions, fees, tips. */
async function answer(method: string, p: string, body: string): Promise<NextResponse> {
  let m: RegExpMatchArray | null;
  if (method === "POST") {
    if (p !== "tx") return text("not found", 404);
    if (!/^[0-9a-f]{20,200000}$/.test(body)) return text("not a raw transaction", 400);
    return text(await api.broadcast(body));
  }
  if (p === "blocks/tip/height") return text(String(await api.tipHeight()));
  if ((m = p.match(/^block-height\/(\d{1,9})$/))) return text(await api.blockHash(Number(m[1])));
  if ((m = p.match(new RegExp(`^address/${ADDRESS}/utxo$`)))) return json(await api.rawUtxos(m[1]));
  if ((m = p.match(new RegExp(`^address/${ADDRESS}/txs/mempool$`)))) return json(await api.addressTxsMempool(m[1]));
  if ((m = p.match(new RegExp(`^address/${ADDRESS}/txs/chain(?:/${HASH})?$`)))) return json(await api.addressTxsChain(m[1], m[2]));
  if ((m = p.match(new RegExp(`^tx/${HASH}$`)))) return json(await api.tx(m[1]));
  if ((m = p.match(new RegExp(`^tx/${HASH}/status$`)))) return json(await api.txStatus(m[1]));
  if ((m = p.match(new RegExp(`^block/${HASH}/txids$`)))) return json(await api.blockTxids(m[1]));
  if (p === "v1/fees/recommended") return json(await api.fees());
  return text("not found", 404);
}

async function proxy(req: NextRequest, path: string[]) {
  const body = req.method === "POST" ? (await req.text()).trim() : "";
  try {
    return await answer(req.method, path.join("/"), body);
  } catch (e) {
    const status = e instanceof ApiError && e.status >= 400 ? e.status : 502;
    return text((e as Error).message.slice(0, 300), status);
  }
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path);
}

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(req, params.path);
}
