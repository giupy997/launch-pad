"use client";

import Link from "next/link";
import { TokenLogo } from "@/components/TokenLogo";
import { fmtAgo } from "@/lib/format";
import { fmtQuoteMoney, fmtQuoteMoneyNum } from "@/lib/price";
import { Change } from "./Change";
import type { Coin } from "./types";

/** One coin as a row of the list view: the same figures as a card, in a line. */
export function TokenRow({ coin, usd, now }: { coin: Coin; usd: number | null; /** unix seconds, the list's one clock */ now: number }) {
  const { token: t, stats, quote } = coin;
  return (
    <Link
      href={`/token/${t.address}`}
      className="card card-hover grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[auto_minmax(0,1.6fr)_1fr_0.8fr_1fr_1.2fr_0.9fr]"
    >
      <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={36} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-white">
          {t.name} <span className="font-mono text-xs font-normal text-zinc-500">${t.symbol}</span>
        </div>
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-600">
          {t.curve.graduated ? "graduated" : `curve ${stats.progress.toFixed(1)}%`}
        </div>
      </div>
      <div className="text-right sm:text-left">
        <div className="label hidden sm:block">Market cap</div>
        <div className="font-mono text-sm text-zinc-200">{fmtQuoteMoneyNum(stats.mcap, quote.symbol, usd)}</div>
        <div className="sm:hidden">
          <Change pct={stats.change24h} className="text-[11px]" />
        </div>
      </div>
      <div className="hidden sm:block">
        <div className="label">24h</div>
        <Change pct={stats.change24h} className="text-sm" />
      </div>
      <div className="hidden sm:block">
        <div className="label">Volume 24h</div>
        <div className="font-mono text-sm text-zinc-300">
          {stats.volume24h === undefined ? "…" : stats.volume24h === 0n ? "—" : fmtQuoteMoney(stats.volume24h, quote.decimals, quote.symbol, usd)}
        </div>
      </div>
      <div className="hidden sm:block">
        <div className="label">Curve</div>
        <div className="mt-1.5 bar-track">
          <div className="bar-fill" style={{ width: `${Math.min(stats.progress, 100)}%` }} />
        </div>
      </div>
      <div className="hidden sm:block text-right">
        <div className="label">Last trade</div>
        <div className="font-mono text-xs text-zinc-400">{stats.lastTrade ? fmtAgo(stats.lastTrade, now) : "—"}</div>
      </div>
    </Link>
  );
}
