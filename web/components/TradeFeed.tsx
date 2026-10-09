"use client";

import { type Trade, type TradeKind } from "@/lib/events";
import { fmtUnits, fmtTokens, shortAddr } from "@/lib/format";
import { useExplorer, useNativeSymbol } from "@/lib/hooks";

// the protocol's own pool swaps, named for what they are rather than as a
// trader's buy or sell: who swapped, and what the swap did
const KIND_TRADER: Record<TradeKind, string> = {
  harvest: "the pad's migrator",
  buyback: "the pad",
};
const KIND_TITLES: Record<TradeKind, string> = {
  harvest: "the pad's migrator sold the pool's fee buckets: the quote went to the treasury, the creator, the holders and the burn pot",
  buyback: "the pad bought coins back on its pool with the burn pot, and burned them",
};

export function TradeFeed({
  trades,
  symbol,
  quoteSymbol: quoteSymbolProp,
  quoteDecimals = 18,
  truncated,
  loading = false,
  header = true,
}: {
  trades: Trade[];
  symbol: string;
  quoteSymbol?: string;
  quoteDecimals?: number;
  truncated: boolean;
  /** the first scan of the chain is still running: not "no trades" yet */
  loading?: boolean;
  /** the title bar with the count; off when a tab above already says it */
  header?: boolean;
}) {
  const explorer = useExplorer();
  const native = useNativeSymbol();
  const quoteSymbol = quoteSymbolProp ?? native;
  const recent = [...trades].reverse().slice(0, 20);

  return (
    <div className="rounded-xl border border-white/10 bg-black">
      {header && (
        <div className="px-4 py-3 border-b border-white/[0.06] font-mono text-[10px] tracking-widest uppercase text-zinc-500">
          Trades {trades.length > 0 && `(${trades.length}${truncated ? "+" : ""})`}
        </div>
      )}
      {recent.length === 0 && (
        <p className="px-4 py-6 text-sm text-zinc-600">{loading ? "Reading the chain…" : "No trades yet."}</p>
      )}
      <ul className="divide-y divide-white/[0.06]">
        {recent.map((t) => (
          <li key={t.tx + t.type + t.trader} className="px-4 py-2.5 flex items-center gap-3 text-sm">
            {t.kind ? (
              <span
                className="font-mono text-[10px] tracking-widest uppercase px-2 py-0.5 rounded-full border border-dashed border-zinc-700 text-zinc-500"
                title={KIND_TITLES[t.kind]}
              >
                {t.kind}
              </span>
            ) : (
              <span
                className={`font-mono text-[10px] tracking-widest uppercase px-2 py-0.5 rounded-full border ${
                  t.type === "buy" ? "border-white text-white" : "border-zinc-600 text-zinc-400"
                }`}
              >
                {t.type}
              </span>
            )}
            {t.venue === "pool" && (
              <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-600" title="a swap in the coin's pool on the DEX">
                pool
              </span>
            )}
            <a
              href={`${explorer}/address/${t.trader}`}
              target="_blank"
              className="font-mono text-xs text-zinc-400 hover:text-white underline"
            >
              {t.kind ? KIND_TRADER[t.kind] : shortAddr(t.trader)}
            </a>
            <span className="flex-1 text-right text-zinc-300">
              {fmtTokens(t.tokens)} {symbol}
            </span>
            <span className="hidden sm:block w-28 text-right text-zinc-500">{fmtUnits(t.eth, quoteDecimals)} {quoteSymbol}</span>
            <a
              href={`${explorer}/tx/${t.tx}`}
              target="_blank"
              className="font-mono text-[10px] text-zinc-600 hover:text-white"
              title={t.timestamp ? new Date(t.timestamp * 1000).toLocaleString() : undefined}
            >
              {t.timestamp ? timeAgo(t.timestamp) : "↗"}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
