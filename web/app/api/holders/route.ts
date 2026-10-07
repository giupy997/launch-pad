import { NextResponse, type NextRequest } from "next/server";
import { EXPLORER_API } from "@/lib/explorers";
import { POINTS_CHAINS } from "@/lib/points/chains";
import { countHolders } from "@/lib/holders/count";
import { recentScanErrors } from "@/lib/trades/scan";

const TOKEN = /^0x[0-9a-fA-F]{40}$/;
const cache = (seconds: number) => ({
  "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
  "netlify-cdn-cache-control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
});
const none = { holders: null, transfers: null, launched: null, partial: false, top: [] };
// a fresh timeout for every fetch: one signal shared by all would be spent eight seconds after the module loaded
const get = (url: string) => fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
const answered = (r: PromiseSettledResult<Response>) => (r.status === "fulfilled" && r.value.ok ? r.value : null);

/** How many wallets hold a token: counted from the chain itself where the
 *  table in lib/points/chains.ts names the chain (lib/holders/count.ts), with
 *  `partial` while an old coin's history is still being read; else from the
 *  chain's Blockscout, its count of every address with a balance less the
 *  contracts among them (the pad, the pool), which its first page of holders
 *  — the largest, where the contracts sit — tells apart. A minute at the
 *  edge; nodes and explorer that do not answer give nulls, not an error, so
 *  the page shows a dash. */
export async function GET(req: NextRequest) {
  const chain = Number(req.nextUrl.searchParams.get("chain"));
  const token = req.nextUrl.searchParams.get("token") ?? "";
  // `debug=1`: what the count did and the nodes' last refusals, uncached, for a look from the terminal
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
      const body = { holders, transfers: null, launched, partial, top };
      if (debug) return NextResponse.json({ ...body, debug: { ...did, errors: recentScanErrors.slice(-12) } }, { headers: { "cache-control": "no-store" } });
      return NextResponse.json(body, { headers: cache(partial ? 5 : 60) });
    } catch (e) {
      // in the function's log, so a count that never comes can be understood from there
      console.warn(`[holders] the chain's nodes gave no count for ${token} on ${chain}:`, e instanceof Error ? e.message : e);
      if (debug) {
        return NextResponse.json(
          { ...none, debug: { failed: e instanceof Error ? e.message : String(e), errors: recentScanErrors.slice(-12) } },
          { headers: { "cache-control": "no-store" } }
        );
      }
    }
  }
  if (!api) return NextResponse.json(none, { headers: cache(30) });
  // the three reads together; one that fails takes nothing but its own figure with it
  const [counters, page, addr] = (
    await Promise.allSettled([get(`${api}/tokens/${token}/counters`), get(`${api}/tokens/${token}/holders`), get(`${api}/addresses/${token}`)])
  ).map(answered);
  // when the coin was created: the explorer names the creating transaction, the transaction its time
  let launched: number | null = null;
  try {
    if (addr) {
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
    const c = (await counters.json()) as { token_holders_count?: string; transfers_count?: string };
    const num = (v?: string) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
    const total = num(c.token_holders_count);
    let contracts = 0;
    if (page) {
      const p = (await page.json()) as { items?: { address?: { is_contract?: boolean }; value?: string }[] };
      contracts = (p.items ?? []).filter((i) => i.address?.is_contract === true && i.value !== "0").length;
    }
    const holders = total === null ? null : Math.max(0, total - contracts);
    return NextResponse.json({ holders, transfers: num(c.transfers_count), launched, partial: false, top: [] }, { headers: cache(60) });
  } catch {
    return NextResponse.json({ ...none, launched }, { headers: cache(30) });
  }
}
