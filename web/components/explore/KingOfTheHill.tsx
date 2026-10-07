"use client";

import Link from "next/link";
import { TokenLogo } from "@/components/TokenLogo";
import { fmtNum } from "@/lib/format";
import { fmtQuoteMoney, fmtQuoteMoneyNum } from "@/lib/price";
import { Sparkline } from "./Sparkline";
import { Change } from "./Change";
import type { Coin, Quote } from "./types";

/** The coin closest to graduating: the one to watch, with the shape of its
 *  day and its three figures. */
export function KingOfTheHill({
  coin,
  quote,
  usd,
  holders,
  points,
}: {
  coin: Coin;
  quote: Quote;
  usd: number | null;
  holders: number | null | undefined;
  points: number[];
}) {
  const { token: t, stats } = coin;
  return (
    <Link href={`/token/${t.address}`} className="card card-hover block p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <span className="pill">
          <span aria-hidden>♛</span> King of the Hill
        </span>
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
          closest to graduation · {stats.progress.toFixed(1)}%
        </span>
      </div>
      <div className="mt-5 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={56} />
          <div className="min-w-0">
            <div className="display text-3xl sm:text-4xl leading-none text-white truncate">${t.symbol}</div>
            <div className="mt-1.5 text-sm text-zinc-400 truncate">{t.name}</div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="display text-3xl sm:text-4xl leading-none text-white">{fmtQuoteMoneyNum(stats.mcap, quote.symbol, usd)}</div>
          <div className="mt-1.5 text-sm">
            <Change pct={stats.change24h} />
          </div>
        </div>
      </div>
      <div className="mt-5">
        <Sparkline points={points} className="h-24 w-full" />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-4">
        <div>
          <div className="label">Price</div>
          <div className="mt-1 font-mono text-sm text-zinc-200">{fmtNum(stats.price)}</div>
          <div className="font-mono text-[10px] text-zinc-500">{quote.symbol}</div>
        </div>
        <div>
          <div className="label">24h volume</div>
          <div className="mt-1 font-mono text-sm text-zinc-200">
            {stats.volume24h === undefined ? "…" : stats.volume24h === 0n ? "—" : fmtQuoteMoney(stats.volume24h, quote.decimals, quote.symbol, usd)}
          </div>
        </div>
        <div>
          <div className="label">Holders</div>
          <div className="mt-1 font-mono text-sm text-zinc-200">{holders === undefined ? "…" : holders === null ? "—" : holders.toLocaleString("en-US")}</div>
        </div>
      </div>
    </Link>
  );
}
