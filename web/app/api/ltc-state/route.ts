// The live ledger snapshot, fetched server-side from the desk (a VPS running
// `node litecoin/desk.ts`) when LTC_STATE_URL is set. Unset → 404, and the
// pages fall back to the static web/public/litecoin/state.json committed
// with the site. Same-origin for the browser, no CORS, nothing cached.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const URL_ = process.env.LTC_STATE_URL;

export async function GET() {
  if (!URL_) return NextResponse.json({ error: "LTC_STATE_URL not set" }, { status: 404 });
  try {
    const r = await fetch(URL_, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return NextResponse.json({ error: `desk answered ${r.status}` }, { status: 502 });
    // a pass every minute: a few seconds at the edge spare the desk a round trip per visitor
    return new NextResponse(await r.text(), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=5, s-maxage=15, stale-while-revalidate=60",
        "netlify-cdn-cache-control": "public, s-maxage=15, stale-while-revalidate=60",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: `desk unreachable: ${(e as Error).message}` }, { status: 502 });
  }
}
