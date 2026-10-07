"use client";

import { useState } from "react";
import { TradeFeed } from "@/components/TradeFeed";
import { HolderList } from "@/components/HolderList";
import type { Trade } from "@/lib/events";
import type { Holder } from "@/lib/holders";

type Tab = "trades" | "holders";

/** Under the chart: the coin's trades and its holders, one list at a time
 *  under two tabs, each with its count. */
export function TokenActivity({
  trades,
  holders,
}: {
  trades: { trades: Trade[]; symbol: string; quoteSymbol: string; quoteDecimals: number; truncated: boolean; loading: boolean };
  holders: { list: Holder[]; total: number | null; partial: boolean; loading: boolean; symbol: string; labels: Record<string, string>; explorer: string };
}) {
  const [tab, setTab] = useState<Tab>("trades");
  const tradeCount = trades.trades.length > 0 ? `${trades.trades.length}${trades.truncated ? "+" : ""}` : null;
  const holderCount = holders.total === null ? null : `${holders.partial ? "≥ " : ""}${holders.total.toLocaleString("en-US")}`;
  return (
    <section>
      <div role="tablist" className="mb-3 flex items-center gap-1 border-b border-white/[0.06]">
        <TabButton active={tab === "trades"} onClick={() => setTab("trades")} count={tradeCount}>
          Trades
        </TabButton>
        <TabButton active={tab === "holders"} onClick={() => setTab("holders")} count={holderCount}>
          Holders
        </TabButton>
      </div>
      {tab === "trades" ? (
        <TradeFeed
          trades={trades.trades}
          symbol={trades.symbol}
          quoteSymbol={trades.quoteSymbol}
          quoteDecimals={trades.quoteDecimals}
          truncated={trades.truncated}
          loading={trades.loading}
          header={false}
        />
      ) : (
        <HolderList
          holders={holders.list}
          total={holders.total}
          partial={holders.partial}
          loading={holders.loading}
          symbol={holders.symbol}
          labels={holders.labels}
          explorer={holders.explorer}
        />
      )}
    </section>
  );
}

function TabButton({ active, onClick, count, children }: { active: boolean; onClick: () => void; count: string | null; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors duration-150 ${
        active ? "border-white text-white" : "border-transparent text-zinc-500 hover:text-zinc-200"
      }`}
    >
      {children}
      {count !== null && <span className="font-mono text-[11px] text-zinc-500">{count}</span>}
    </button>
  );
}
