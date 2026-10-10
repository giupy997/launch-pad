// The browser's road to the Litecoin chain, in Esplora's dialect. Same-origin,
// so the wallet pages need no CORS from any explorer, and what answers is
// LTC_API_UPSTREAM: an Esplora endpoint, a Blockbook one (…/api/v2,
// translated here), or several, comma separated, tried in order when one is
// down; the public explorers of the chain come after them whatever is set,
// so one explorer's outage never leaves the pages blind. LTC_API_KEY goes
// to Blockbook endpoints.
import { NextResponse, type NextRequest } from "next/server";
import { ApiError } from "@/lib/litecoin/esplora";
import { chainApi, withFallbacks } from "@/lib/litecoin/chain";

export const dynamic = "force-dynamic";

const NETWORK = process.env.NEXT_PUBLIC_LTC_NETWORK === "main" ? "main" : "test";
/** The hosting function has ten seconds in all: a read may wait this long on
 *  one explorer, so that a second one still gets its turn and the browser
 *  sees an answer, not a dead connection. A broadcast waits longer: it is
 *  sent once, and a slow explorer may well have relayed it. */
const READ_TIMEOUT_MS = 4_000;
const SEND_TIMEOUT_MS = 8_000;
const SPEC = withFallbacks(process.env.LTC_API_UPSTREAM, NETWORK);
const api = chainApi(SPEC, NETWORK, process.env.LTC_API_KEY, READ_TIMEOUT_MS);
const sender = chainApi(SPEC, NETWORK, process.env.LTC_API_KEY, SEND_TIMEOUT_MS);

const ADDRESS = "([a-zA-Z0-9]{20,90})";
const HASH = "([0-9a-f]{64})";
/** Seconds an answer may be served from the edge: coins and histories move
 *  with the mempool, tips and fees with blocks, a block's hash never. */
const cache = (seconds: number): Record<string, string> =>
  seconds === 0
    ? { "cache-control": "no-store" }
    : {
        "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
        "netlify-cdn-cache-control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
      };
const text = (body: string, status = 200, seconds = 0) =>
  new NextResponse(body, { status, headers: { "content-type": "text/plain", ...cache(status === 200 ? seconds : 0) } });
const json = (body: unknown, seconds = 0) => NextResponse.json(body, { headers: cache(seconds) });

/** Only what the pages use: address history and coins, transactions, fees, tips. */
async function answer(method: string, p: string, body: string): Promise<NextResponse> {
  let m: RegExpMatchArray | null;
  if (method === "POST") {
    if (p !== "tx") return text("not found", 404);
    if (!/^[0-9a-f]{20,200000}$/.test(body)) return text("not a raw transaction", 400);
    return text(await sender.broadcast(body));
  }
  if (p === "blocks/tip/height") return text(String(await api.tipHeight()), 200, 20);
  if ((m = p.match(/^block-height\/(\d{1,9})$/))) return text(await api.blockHash(Number(m[1])), 200, 3600);
  if ((m = p.match(new RegExp(`^address/${ADDRESS}/utxo$`)))) return json(await api.rawUtxos(m[1]), 5);
  if ((m = p.match(new RegExp(`^address/${ADDRESS}/txs/mempool$`)))) return json(await api.addressTxsMempool(m[1]), 5);
  if ((m = p.match(new RegExp(`^address/${ADDRESS}/txs/chain(?:/${HASH})?$`)))) return json(await api.addressTxsChain(m[1], m[2]), 5);
  if ((m = p.match(new RegExp(`^tx/${HASH}$`)))) return json(await api.tx(m[1]), 10);
  if ((m = p.match(new RegExp(`^tx/${HASH}/status$`)))) return json(await api.txStatus(m[1]), 5);
  if ((m = p.match(new RegExp(`^block/${HASH}/txids$`)))) return json(await api.blockTxids(m[1]), 600);
  if (p === "v1/fees/recommended") return json(await api.fees(), 60);
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

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
