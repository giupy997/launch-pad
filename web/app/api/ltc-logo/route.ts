// Coin logos for Notus on Litecoin: the browser sends the square image it
// made, the site pins it to IPFS (Pinata, with the operator's PINATA_JWT)
// and answers with the ipfs:// URI the logo instruction carries. GET says
// whether uploads are on; without the key, creators paste a URL instead.
import { NextResponse, type NextRequest } from "next/server";
import { MAX_LOGO_BYTES, pinLogo } from "@/lib/litecoin/pin";

export const dynamic = "force-dynamic";

const JWT = process.env.PINATA_JWT;

export async function GET() {
  return NextResponse.json({ enabled: !!JWT, maxBytes: MAX_LOGO_BYTES }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!JWT) return NextResponse.json({ error: "uploads are off on this site: paste an image URL instead" }, { status: 503 });
  let body: { dataUri?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "expected JSON" }, { status: 400 });
  }
  if (typeof body.dataUri !== "string" || body.dataUri.length > MAX_LOGO_BYTES * 2) {
    return NextResponse.json({ error: "expected a small image data URI" }, { status: 400 });
  }
  try {
    const uri = await pinLogo(body.dataUri, typeof body.name === "string" ? body.name : "coin", JWT);
    return NextResponse.json({ uri }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: /pinning failed/.test(msg) ? 502 : 400 });
  }
}
