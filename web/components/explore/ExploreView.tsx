"use client";

import { useMemo, useState } from "react";
import { TokenCard } from "@/components/TokenCard";
import { KingOfTheHill } from "./KingOfTheHill";
import { Contenders } from "./Contenders";
import { ExploreControls, type Sort, type Tab, type View } from "./ExploreControls";
import { TokenRow } from "./TokenRow";
import { useNow } from "@/lib/useNow";
import type { Coin } from "./types";

const num = (v: bigint | undefined) => (v === undefined ? 0 : Number(v));
const byProgress = (a: Coin, b: Coin) => b.stats.progress - a.stats.progress;

/** the list in the order asked; the input comes newest first */
function sortCoins(list: Coin[], sort: Sort): Coin[] {
  const c = [...list];
  switch (sort) {
    case "graduated":
      return c.sort(
        (a, b) =>
          Number(b.token.curve.graduated) - Number(a.token.curve.graduated) ||
          (b.stats.lastTrade ?? 0) - (a.stats.lastTrade ?? 0) ||
          b.stats.progress - a.stats.progress
      );
    case "lastTrade":
      return c.sort((a, b) => (b.stats.lastTrade ?? -1) - (a.stats.lastTrade ?? -1));
    case "mcap":
      return c.sort((a, b) => b.stats.mcap - a.stats.mcap);
    case "volume":
      return c.sort((a, b) => num(b.stats.volume24h) - num(a.stats.volume24h) || b.stats.mcap - a.stats.mcap);
    case "progress":
      return c.sort(byProgress);
    case "newest":
      return c;
    case "oldest":
      return c.reverse();
  }
}

/** The explore page below the hero: the king and its contenders, then every
 *  coin under tabs, a sort and a choice of cards or rows. Pure rendering:
 *  the page computes the figures (see types.ts). */
export function ExploreView({
  coins,
  usd,
  loading,
  error,
  king,
}: {
  coins: Coin[];
  usd: number | null;
  loading: boolean;
  error: boolean;
  /** the coin closest to graduating, with its holders (so far, while `holdersPartial`) and the day's price line */
  king: { coin: Coin; holders: number | null | undefined; holdersPartial: boolean; points: number[] } | null;
}) {
  const [tab, setTabState] = useState<Tab>("trending");
  const [sort, setSort] = useState<Sort>("volume");
  const [view, setView] = useState<View>("grid");
  const [query, setQuery] = useState("");
  const now = useNow(30_000); // one clock for every row's "last trade"
  // a tab brings its natural order; the sort menu may then change it
  const setTab = (t: Tab) => {
    setTabState(t);
    setSort(t === "graduated" ? "graduated" : t === "new" ? "newest" : "volume");
  };

  const graduated = coins.filter((c) => c.token.curve.graduated);
  const contenders = coins
    .filter((c) => !c.token.curve.graduated && c !== king?.coin)
    .sort(byProgress)
    .slice(0, 5);

  const q = query.trim().toLowerCase();
  const list = useMemo(() => {
    let out = tab === "graduated" ? coins.filter((c) => c.token.curve.graduated) : coins;
    if (q) out = out.filter((c) => c.token.name.toLowerCase().includes(q) || c.token.symbol.toLowerCase().includes(q) || c.token.address.toLowerCase() === q);
    return sortCoins(out, sort);
  }, [coins, tab, q, sort]);

  return (
    <div className="space-y-10">
      {king && (
        <section className="grid gap-4 lg:grid-cols-[1fr_360px]">
          <KingOfTheHill coin={king.coin} usd={usd} holders={king.holders} holdersPartial={king.holdersPartial} points={king.points} />
          <Contenders coins={contenders} usd={usd} />
        </section>
      )}
      <section className="space-y-5">
        <ExploreControls
          tab={tab}
          onTab={setTab}
          sort={sort}
          onSort={setSort}
          view={view}
          onView={setView}
          query={query}
          onQuery={setQuery}
          graduated={graduated.length}
        />

        {loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card p-4 animate-pulse">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-lg bg-zinc-900" />
                  <div className="space-y-2">
                    <div className="h-3 w-24 rounded bg-white/[0.06]" />
                    <div className="h-2 w-12 rounded bg-white/[0.06]" />
                  </div>
                </div>
                <div className="mt-4 h-2 w-full rounded bg-white/[0.06]" />
                <div className="mt-3 h-1 w-full rounded bg-white/[0.06]" />
              </div>
            ))}
          </div>
        )}
        {!loading && list.length === 0 && (
          <p className="text-zinc-500">
            {error
              ? "The chain is not answering right now; trying again."
              : q
                ? "No coins match your search."
                : tab === "graduated"
                  ? "No coin has graduated yet."
                  : "No coins yet. Be the first to launch."}
          </p>
        )}

        {view === "grid" ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((c) => (
              <TokenCard key={c.token.address} token={c.token} volume24h={c.stats.volume24h} usd={usd} />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {list.map((c) => (
              <TokenRow key={c.token.address} coin={c} usd={usd} now={now} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
