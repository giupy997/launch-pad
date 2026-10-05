import { NextResponse, type NextRequest } from "next/server";
import { EXPLORER_API } from "@/lib/explorers";

const TOKEN = /^0x[0-9a-fA-F]{40}$/;
const cache = (seconds: number) => ({
  "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
  "netlify-cdn-cache-control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
});
const none = { holders: null, transfers: null };

/** A token's holder count from the chain's Blockscout, which counts every
 *  address with a balance, contracts included (the page takes the pad and the
 *  pool off). A minute at the edge; an explorer that does not answer gives
 *  nulls, not an error, so the page shows a dash. */
export async function GET(req: NextRequest) {
  const chain = Number(req.nextUrl.searchParams.get("chain"));
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const api = EXPLORER_API[chain];
  if (!api || !TOKEN.test(token)) return NextResponse.json({ error: "unknown chain or token" }, { status: 400 });
  try {
    const r = await fetch(`${api}/tokens/${token}/counters`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { accept: "application/json" },
    });
    if (!r.ok) return NextResponse.json(none, { headers: cache(30) });
    const j = (await r.json()) as { token_holders_count?: string; transfers_count?: string };
    const num = (v?: string) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
    return NextResponse.json({ holders: num(j.token_holders_count), transfers: num(j.transfers_count) }, { headers: cache(60) });
  } catch {
    return NextResponse.json(none, { headers: cache(30) });
  }
}
