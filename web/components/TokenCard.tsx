"use client";

import Link from "next/link";
import { type TokenInfo, spotPrice, curveProgress, quoteInfo, useAppChain } from "@/lib/hooks";
import { fmtUnits, shortAddr } from "@/lib/format";
import { TokenLogo } from "@/components/TokenLogo";

export function TokenCard({ token: t }: { token: TokenInfo }) {
  const progress = curveProgress(t.curve);
  const chain = useAppChain();
  const q = quoteInfo(chain.id, t.curve.quoteAsset);
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
          <div className="label">Price</div>
          <div className="mt-0.5 display text-2xl leading-none text-white">{fmtUnits(spotPrice(t.curve), q.decimals)} <span className="text-base text-zinc-400">{q.symbol}</span></div>
        </div>
        <div className="text-right">
          <div className="label">Raised</div>
          <div className="mt-0.5 font-mono text-sm text-zinc-300">{fmtUnits(t.curve.realEth, q.decimals)} {q.symbol}</div>
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
