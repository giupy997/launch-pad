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
      className="rounded-xl border border-zinc-800 bg-black p-4 hover:border-white transition-colors"
    >
      <div className="flex items-center gap-3">
        <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={44} />
        <div className="min-w-0">
          <div className="font-semibold truncate flex items-center gap-2">
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
          </div>
          <div className="font-mono text-xs text-zinc-400">${t.symbol}</div>
        </div>
      </div>
      <div className="mt-3 text-xs text-zinc-500">creator {shortAddr(t.curve.creator)}</div>
      <div className="mt-3 flex justify-between text-sm">
        <span className="text-zinc-300">{fmtUnits(spotPrice(t.curve), q.decimals)} {q.symbol}</span>
        <span className="text-zinc-500">raised {fmtUnits(t.curve.realEth, q.decimals)} {q.symbol}</span>
      </div>
      <div className="mt-3 h-1 rounded bg-zinc-800 overflow-hidden">
        <div className="h-full bg-white" style={{ width: `${Math.min(progress, 100)}%` }} />
      </div>
      <div className="mt-1.5 font-mono text-[10px] tracking-widest uppercase text-zinc-500">
        {t.curve.graduated ? "Graduated" : `curve ${progress.toFixed(1)}%`}
      </div>
    </Link>
  );
}
