"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConfig } from "wagmi";
import { readContractsQueryOptions } from "wagmi/query";
import { type TokenInfo, marketCapOf, curveProgress, quoteInfo, useAppChain, useLaunchpadAddress, ZERO_ADDRESS } from "@/lib/hooks";
import { tokenLiveReads, tokenStaticReads } from "@/lib/tokenReads";
import { poolMarketCapOf, usePool } from "@/lib/pool";
import { fmtNum, fmtUnits, shortAddr } from "@/lib/format";
import { TokenLogo } from "@/components/TokenLogo";
import { fmtQuoteMoney, fmtQuoteMoneyNum, isLtcQuote } from "@/lib/price";

export function TokenCard({
  token: t,
  volume24h,
  usd,
}: {
  token: TokenInfo;
  /** the last day's trading in quote wei; undefined while unknown */
  volume24h?: bigint;
  /** the LTC price, for LTC-quoted coins; null while unknown */
  usd?: number | null;
}) {
  const progress = curveProgress(t.curve);
  const chain = useAppChain();
  const q = quoteInfo(chain.id, t.curve.quoteAsset);
  const pad = useLaunchpadAddress() ?? ZERO_ADDRESS;
  // a graduated coin is priced by its pool, not by the curve it closed
  const pool = usePool(pad, t.address, chain.id, t.curve.graduated);
  // The coin's page opens on two multicalls (lib/tokenReads.ts): ask for them
  // now, so a tap finds them in the cache and the page shows at once. Same
  // contracts and chain id as the page's hooks, hence the same query keys.
  const config = useConfig();
  const queryClient = useQueryClient();
  useEffect(() => {
    void queryClient.prefetchQuery({
      ...readContractsQueryOptions(config, { contracts: tokenStaticReads(pad, t.address, chain.id), chainId: chain.id }),
      staleTime: Infinity,
    });
    void queryClient.prefetchQuery({
      ...readContractsQueryOptions(config, { contracts: tokenLiveReads(pad, t.address, chain.id), chainId: chain.id }),
      staleTime: 30_000,
    });
  }, [config, queryClient, pad, t.address, chain.id]);
  const mcap = t.curve.graduated && pool.data ? poolMarketCapOf(pool.data, q.decimals) : marketCapOf(t.curve, q.decimals);
  const inDollars = !!usd && isLtcQuote(q.symbol);
  return (
    <Link
      href={`/token/${t.address}`}
      className="card card-hover group block p-5"
    >
      <div className="flex items-center gap-3">
        <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={52} />
        <div className="min-w-0">
          <div className="text-lg font-semibold text-white truncate flex items-center gap-2">
            {t.name}
            {t.meta.livestream && (
              <span className="font-mono text-[9px] tracking-widest uppercase border border-white rounded-full px-1.5 py-px shrink-0">
                ● Live
              </span>
            )}
            {q.preIpo && (
              <span className="font-mono text-[9px] tracking-widest uppercase bg-white text-black rounded-full px-1.5 py-px shrink-0">
                Pre-IPO
              </span>
            )}
            {t.feesToHolders && (
              <span
                title="100% of the creator fee pot goes to holders as cashback"
                className="font-mono text-[9px] tracking-widest uppercase border border-white rounded-full px-1.5 py-px shrink-0"
              >
                ✦ Rewards
              </span>
            )}
          </div>
          <div className="font-mono text-xs text-zinc-400">${t.symbol}</div>
        </div>
      </div>
      <div className="mt-1 font-mono text-xs text-zinc-500">by {shortAddr(t.curve.creator)}</div>
      <div className="mt-5 flex items-end justify-between gap-3">
        <div>
          <div className="label">Market cap</div>
          <div className="mt-0.5 display text-2xl leading-none text-white">{fmtQuoteMoneyNum(mcap, q.symbol, usd)}</div>
          {inDollars && (
            <div className="mt-1 font-mono text-[11px] text-zinc-500">
              {fmtNum(mcap)} {q.symbol}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="label">Volume 24h</div>
          <div className="mt-0.5 font-mono text-sm text-zinc-300">
            {volume24h === undefined ? "…" : volume24h === 0n ? "—" : fmtQuoteMoney(volume24h, q.decimals, q.symbol, usd)}
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-500">
            {t.curve.graduated
              ? pool.data
                ? `pool ${fmtUnits(pool.data.quoteReserve, q.decimals)} ${q.symbol}`
                : "in its pool"
              : `raised ${fmtUnits(t.curve.realEth, q.decimals)} ${q.symbol}`}
          </div>
        </div>
      </div>
      <div className="mt-4 bar-track">
        <div className="bar-fill" style={{ width: `${Math.min(progress, 100)}%` }} />
      </div>
      <div className="mt-2 font-mono text-[10px] tracking-widest uppercase text-zinc-500">
        {t.curve.graduated ? "graduated · locked pool" : `curve ${progress.toFixed(1)}%`}
      </div>
    </Link>
  );
}
