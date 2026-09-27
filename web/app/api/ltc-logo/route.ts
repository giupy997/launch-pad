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

export const dynamic = "force-dynamic";

const JWT = process.env.PINATA_JWT;

function origin(req: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (configured) return configured;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "localhost:3000";
  return `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
}

export async function GET() {
  const via = JWT ? "ipfs" : siteStore() ? "site" : null;
  return NextResponse.json({ enabled: !!via, via, maxBytes: MAX_LOGO_BYTES }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  let body: { dataUri?: unknown; name?: unknown };
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
    if (JWT) {
      const uri = await pinLogo(body.dataUri, name, JWT);
      return NextResponse.json({ uri, via: "ipfs" }, { headers: { "cache-control": "no-store" } });
    }
    const store = siteStore();
    if (!store) return NextResponse.json({ error: "uploads are off on this site: paste an image URL instead" }, { status: 503 });
    const { type, bytes } = decodeDataUri(body.dataUri);
    const id = bytesToHex(sha256(bytes)).slice(0, 16); // content-addressed: the same image is the same URL
    await store.set(id, new Blob([new Uint8Array(bytes)], { type }), { metadata: { type, name: name.slice(0, 32) } });
    return NextResponse.json({ uri: `${origin(req)}/i/${id}`, via: "site" }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: /pinning failed|store/i.test(msg) ? 502 : 400 });
  }
}
