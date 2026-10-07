"use client";

import Link from "next/link";
import { TokenLogo } from "@/components/TokenLogo";
import { fmtQuoteMoneyNum } from "@/lib/price";
import { Change } from "./Change";
import type { Coin, Quote } from "./types";

/** The coins behind the king, nearest to graduation first. */
export function Contenders({ coins, quote, usd }: { coins: Coin[]; quote: Quote; usd: number | null }) {
  return (
    <div className="card p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">Contenders</h2>
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">closest to graduation</span>
      </div>
      {coins.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">No other coin on its curve yet.</p>
      ) : (
        <ol className="mt-3 divide-y divide-white/[0.06]">
          {coins.map(({ token: t, stats }, i) => (
            <li key={t.address}>
              <Link href={`/token/${t.address}`} className="group flex items-center gap-3 py-2.5">
                <span className="w-4 font-mono text-xs text-zinc-600">{i + 1}</span>
                <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-zinc-200 group-hover:text-white">${t.symbol}</span>
                  <span className="block font-mono text-[10px] text-zinc-600">curve {stats.progress.toFixed(1)}%</span>
                </span>
                <span className="text-right">
                  <span className="block font-mono text-sm text-zinc-200">{fmtQuoteMoneyNum(stats.mcap, quote.symbol, usd)}</span>
                  <Change pct={stats.change24h} className="text-[11px]" />
                </span>
                <span className="text-zinc-600 group-hover:text-white" aria-hidden>
                  ↗
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
