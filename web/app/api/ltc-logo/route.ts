// Coin logos for Notus on Litecoin. An OP_RETURN cannot carry an image, so
// the browser sends the square image it made and the site keeps it, then
// answers with the short URL the logo instruction carries:
//   - with PINATA_JWT set, pinned to IPFS through Pinata (`ipfs://Qm…`);
//   - otherwise stored by the site itself (Netlify Blobs, served at /i/<id>).
// GET says whether uploads are on and which way.
import { NextResponse, type NextRequest } from "next/server";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { MAX_LOGO_BYTES, decodeDataUri, pinLogo } from "@/lib/litecoin/pin";
import { siteStore } from "@/lib/litecoin/logoStore";
import { verifyLogo, type LogoAuth } from "@/lib/litecoin/logoAuth";
import { chainApi, withFallbacks } from "@/lib/litecoin/chain";

export const dynamic = "force-dynamic";

const JWT = process.env.PINATA_JWT;
const NETWORK = process.env.NEXT_PUBLIC_LTC_NETWORK === "main" ? "main" : "test";
const chain = chainApi(withFallbacks(process.env.LTC_API_UPSTREAM, NETWORK), NETWORK, process.env.LTC_API_KEY, 4_000);

/** The wallet behind a signed upload, if the signature holds and the wallet holds LTC. */
async function uploader(auth: LogoAuth | undefined, bytes: Uint8Array): Promise<{ address: string } | { error: string; status: number }> {
  const address = verifyLogo(auth, bytes, NETWORK);
  if (!address) return { error: "sign the upload with your wallet (make one or connect Litescribe, or reload the page)", status: 401 };
  try {
    const coins = await chain.utxos(address);
    if (!coins.some((u) => u.value > 0n)) return { error: "fund your wallet first: an upload needs a wallet with some LTC in it", status: 402 };
  } catch {
    return { error: "the explorer did not answer; try again in a minute", status: 503 };
  }
  return { address };
}

function origin(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  return `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
}

export async function GET() {
  const via = JWT ? "ipfs" : siteStore() ? "site" : null;
  return NextResponse.json({ enabled: !!via, via, maxBytes: MAX_LOGO_BYTES, signed: true }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  let body: { dataUri?: unknown; name?: unknown; auth?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  if (typeof body.dataUri !== "string" || body.dataUri.length > MAX_LOGO_BYTES * 2) {
    return NextResponse.json({ error: "expected a small image data URI" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "coin";
  try {
    const { type, bytes } = decodeDataUri(body.dataUri);
    const who = await uploader(body.auth as LogoAuth | undefined, bytes);
    if ("error" in who) return NextResponse.json({ error: who.error }, { status: who.status, headers: { "cache-control": "no-store" } });
    if (JWT) {
      const uri = await pinLogo(body.dataUri, name, JWT);
      return NextResponse.json({ uri, via: "ipfs" }, { headers: { "cache-control": "no-store" } });
    }
    const store = siteStore();
    if (!store) return NextResponse.json({ error: "uploads are off on this site: paste an image URL instead" }, { status: 503 });
    const id = bytesToHex(sha256(bytes)).slice(0, 16); // content-addressed: the same image is the same URL
    // dated, so the collector (gc/route.ts) can tell an upload nobody used from a fresh one
    await store.set(id, new Blob([new Uint8Array(bytes)], { type }), { metadata: { type, name: name.slice(0, 32), uploadedAt: Math.floor(Date.now() / 1000) } });
    return NextResponse.json({ uri: `${origin(req)}/i/${id}`, via: "site" }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: /pinning failed|store/i.test(msg) ? 502 : 400 });
  }
}
