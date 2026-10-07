import { NextResponse, type NextRequest } from "next/server";
import { EXPLORER_API } from "@/lib/explorers";

const TOKEN = /^0x[0-9a-fA-F]{40}$/;
const cache = (seconds: number) => ({
  "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
  "netlify-cdn-cache-control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
});
const none = { holders: null, transfers: null, launched: null };
const opts = { cache: "no-store" as const, signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } };

/** How many wallets hold a token, from the chain's Blockscout: its count of
 *  every address with a balance, less the contracts among them (the pad, the
 *  pool), which its first page of holders — the largest, where the contracts
 *  sit — tells apart. The explorer's own picture, consistent even when it
 *  lags the chain. A minute at the edge; an explorer that does not answer
 *  gives nulls, not an error, so the page shows a dash. */
export async function GET(req: NextRequest) {
  const chain = Number(req.nextUrl.searchParams.get("chain"));
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const api = EXPLORER_API[chain];
  if (!api || !TOKEN.test(token)) return NextResponse.json({ error: "unknown chain or token" }, { status: 400 });
  try {
    const [counters, page, addr] = await Promise.all([
      fetch(`${api}/tokens/${token}/counters`, opts),
      fetch(`${api}/tokens/${token}/holders`, opts),
      fetch(`${api}/addresses/${token}`, opts),
    ]);
    // when the coin was created: the explorer names the creating transaction, the transaction its time
    let launched: number | null = null;
    try {
      if (addr.ok) {
        const a = (await addr.json()) as { creation_transaction_hash?: string; creation_tx_hash?: string };
        const hash = a.creation_transaction_hash ?? a.creation_tx_hash;
        if (hash) {
          const tx = await fetch(`${api}/transactions/${hash}`, opts);
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
    if (!counters.ok) return NextResponse.json({ ...none, launched }, { headers: cache(30) });
    const c = (await counters.json()) as { token_holders_count?: string; transfers_count?: string };
    const num = (v?: string) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
    const total = num(c.token_holders_count);
    let contracts = 0;
    if (page.ok) {
      const p = (await page.json()) as { items?: { address?: { is_contract?: boolean }; value?: string }[] };
      contracts = (p.items ?? []).filter((i) => i.address?.is_contract === true && i.value !== "0").length;
    }
    const holders = total === null ? null : Math.max(0, total - contracts);
    return NextResponse.json({ holders, transfers: num(c.transfers_count), launched }, { headers: cache(60) });
  } catch {
    return NextResponse.json(none, { headers: cache(30) });
  }
}
