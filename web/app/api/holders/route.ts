import { NextResponse, type NextRequest } from "next/server";
import { EXPLORER_API } from "@/lib/explorers";
import { POINTS_CHAINS } from "@/lib/points/chains";
import { countHolders, UnknownCoinError } from "@/lib/holders/count";
import { recentScanErrors } from "@/lib/trades/scan";

const TOKEN = /^0x[0-9a-fA-F]{40}$/;
const FUNCTION_MS = 9_000; // what a request may spend in all, under the hosting function's ten seconds
// Netlify's CDN leaves the query string out of its cache key unless told
// otherwise: without `netlify-vary` every coin would be served the first
// coin's answer.
const cache = (seconds: number) => ({
  "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
  "netlify-cdn-cache-control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
  "netlify-vary": "query",
});
const NO_STORE = { "cache-control": "no-store" };
const none = { holders: null, launched: null, partial: false, top: [] };
const answered = (r: PromiseSettledResult<Response>) => (r.status === "fulfilled" && r.value.ok ? r.value : null);

/** Who holds a token: counted from the chain itself where the table in
 *  lib/points/chains.ts names the chain (lib/holders/count.ts), with
 *  `partial` while an old coin's history is still being read; else from the
 *  chain's Blockscout, its count of every address with a balance less the
 *  contracts among them (the pad, the pool), which its first page of holders
 *  — the largest, where the contracts sit — tells apart. A minute at the
 *  edge; nodes and explorer that do not answer give nulls, not an error, so
 *  the page shows a dash. `debug=1`: what the count did and the nodes' last
 *  refusals, uncached, for a look from the terminal. */
export async function GET(req: NextRequest) {
  const started = Date.now();
  const left = () => FUNCTION_MS - (Date.now() - started);
  const chain = Number(req.nextUrl.searchParams.get("chain"));
  const token = (req.nextUrl.searchParams.get("token") ?? "").toLowerCase();
  const debug = req.nextUrl.searchParams.get("debug") === "1";
  const api = EXPLORER_API[chain];
  const onChain = Object.values(POINTS_CHAINS).find((c) => c.chainId === chain);
  if ((!api && !onChain) || !TOKEN.test(token)) return NextResponse.json({ error: "unknown chain or token" }, { status: 400 });
  // The chain itself first: Base's explorer answers servers with a browser
  // challenge, Liteforge's lags by hours. The explorer stays as the fallback
  // for a count the nodes could not give.
  if (onChain) {
    try {
      const { holders, launched, partial, top, debug: did } = await countHolders(onChain, token as `0x${string}`);
      // the chain and coin answered for, so the browser can tell a stray answer apart
      const body = { chain, token, holders, launched, partial, top };
      if (debug) return NextResponse.json({ ...body, debug: { ...did, errors: recentScanErrors.slice(-12) } }, { headers: NO_STORE });
      return NextResponse.json(body, { headers: cache(partial ? 5 : 60) });
    } catch (e) {
      // an address the pad does not know is no coin: nothing is counted, nothing is kept
      if (e instanceof UnknownCoinError) return NextResponse.json({ error: e.message }, { status: 404, headers: cache(300) });
      // in the function's log, so a count that never comes can be understood from there
      console.warn(`[holders] the chain's nodes gave no count for ${token} on ${chain}:`, e instanceof Error ? e.message : e);
      if (debug) {
        return NextResponse.json({ ...none, debug: { failed: e instanceof Error ? e.message : String(e), errors: recentScanErrors.slice(-12) } }, { headers: NO_STORE });
      }
    }
  }
  // the explorer, in the time the function has left: a fallback that outlives the function answers nobody
  if (!api || left() < 1_500) return NextResponse.json(none, { headers: cache(30) });
  const get = (url: string) =>
    fetch(url, { cache: "no-store", signal: AbortSignal.timeout(Math.max(500, Math.min(8_000, left() - 300))), headers: { accept: "application/json" } });
  // the three reads together; one that fails takes nothing but its own figure with it
  const [counters, page, addr] = (
    await Promise.allSettled([get(`${api}/tokens/${token}/counters`), get(`${api}/tokens/${token}/holders`), get(`${api}/addresses/${token}`)])
  ).map(answered);
  // when the coin was created: the explorer names the creating transaction, the transaction its time
  let launched: number | null = null;
  try {
    if (addr && left() > 1_000) {
      const a = (await addr.json()) as { creation_transaction_hash?: string; creation_tx_hash?: string };
      const hash = a.creation_transaction_hash ?? a.creation_tx_hash;
      if (hash) {
        const tx = await get(`${api}/transactions/${hash}`);
        if (tx.ok) {
          const t = (await tx.json()) as { timestamp?: string };
          const ms = t.timestamp ? Date.parse(t.timestamp) : NaN;
          if (Number.isFinite(ms)) launched = Math.floor(ms / 1000);
        }
      }
    }
  } catch {
    /* the time stays unknown */
  }
  if (!counters) return NextResponse.json({ ...none, launched }, { headers: cache(30) });
  try {
    const c = (await counters.json()) as { token_holders_count?: string };
    const total = c.token_holders_count !== undefined && /^\d+$/.test(c.token_holders_count) ? Number(c.token_holders_count) : null;
    let contracts = 0;
    if (page) {
      const p = (await page.json()) as { items?: { address?: { is_contract?: boolean }; value?: string }[] };
      contracts = (p.items ?? []).filter((i) => i.address?.is_contract === true && i.value !== "0").length;
    }
    const holders = total === null ? null : Math.max(0, total - contracts);
    return NextResponse.json({ chain, token, holders, launched, partial: false, top: [] }, { headers: cache(60) });
  } catch {
    return NextResponse.json({ ...none, launched }, { headers: cache(30) });
  }
}
