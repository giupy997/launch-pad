"use client";

import Link from "next/link";
import { TokenLogo } from "@/components/TokenLogo";
import { fmtUnits } from "@/lib/format";
import { fmtQuoteMoneyNum } from "@/lib/price";
import { Change } from "./Change";
import type { Coin } from "./types";

/** The largest coins, four tiles with the logo given room. */
export function TopByMarketCap({ coins, usd }: { coins: Coin[]; usd: number | null }) {
  if (coins.length === 0) return null;
  return (
    <section>
      <div className="label mb-3">Top by market cap</div>
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {coins.map(({ token: t, stats, quote }) => (
          <Link key={t.address} href={`/token/${t.address}`} className="card card-hover block overflow-hidden">
            <div className="flex h-28 sm:h-36 items-center justify-center bg-gradient-to-b from-white/[0.06] to-transparent">
              <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={72} />
            </div>
            <div className="p-4">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="font-semibold text-white truncate">${t.symbol}</span>
                <span className="text-xs text-zinc-500 truncate">{t.name}</span>
              </div>
              <div className="mt-1.5 display text-2xl leading-none text-white">{fmtQuoteMoneyNum(stats.mcap, quote.symbol, usd)}</div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
                <Change pct={stats.change24h} />
                <span className="hidden font-mono text-zinc-500 truncate sm:inline">
                  {t.curve.graduated ? "in its pool" : `${fmtUnits(t.curve.realEth, quote.decimals)} ${quote.symbol} raised`}
                </span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
