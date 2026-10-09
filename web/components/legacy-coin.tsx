"use client";

import { useAccount, useReadContract } from "wagmi";
import { launchTokenAbi } from "@/lib/abi";
import { DEX_LINKS, type LegacyPad } from "@/lib/config";
import { fmtNum, fmtTokens, shortAddr } from "@/lib/format";
import { curveProgress, priceOf, quoteInfo, useAppChain, useExplorer } from "@/lib/hooks";
import { poolPriceOf, usePool } from "@/lib/pool";
import { TokenLogo } from "@/components/TokenLogo";
import { LegacyCashback } from "@/components/legacy-claims";
import type { LegacyToken } from "@/components/legacy-hooks";
import { LegacySell } from "@/components/legacy-sell";

/** One coin of a legacy pad: what it is, where it stands (on its curve, or
 *  graduated into its pool), and for the connected wallet what it holds
 *  there, a sell box while the coin is on its curve, and its cashback. */
export function LegacyCoin({ pad, token: t, platformFeeBps }: { pad: LegacyPad; token: LegacyToken; platformFeeBps: bigint }) {
  const chain = useAppChain();
  const explorer = useExplorer();
  const { address: user } = useAccount();
  const q = quoteInfo(chain.id, t.curve.quoteAsset);
  const dex = DEX_LINKS[chain.id];
  // a graduated coin's pool, seeded by the legacy pad's migrator
  const pool = usePool(pad.address, t.address, chain.id, t.curve.graduated);
  const progress = curveProgress(t.curve);

  const { data: balance } = useReadContract({
    address: t.address,
    abi: launchTokenAbi,
    functionName: "balanceOf",
    args: user ? [user] : undefined,
    chainId: chain.id,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });
  const held = (balance as bigint | undefined) ?? 0n;

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center gap-3">
        <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={52} />
        <div className="min-w-0">
          <div className="text-lg font-semibold text-white truncate">{t.name}</div>
          <div className="font-mono text-xs text-zinc-400">
            ${t.symbol} ·{" "}
            <a href={`${explorer}/address/${t.address}`} target="_blank" rel="noreferrer" className="underline" title={t.address}>
              {shortAddr(t.address)}
            </a>
          </div>
        </div>
      </div>

      {t.curve.graduated ? (
        <div className="space-y-2">
          <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">graduated · locked pool</div>
          {pool.data && (
            <p className="text-sm text-zinc-400">
              {fmtNum(poolPriceOf(pool.data, q.decimals))} {q.symbol} per coin in its pool on {dex?.name ?? "the DEX"}.
            </p>
          )}
          {pool.isPending && <p className="text-xs text-zinc-500">Reading the pool…</p>}
          {pool.none && <p className="text-xs text-zinc-500">The pad seeded no pool for this coin: its reserve is still on the pad.</p>}
          <div className="flex flex-wrap gap-2">
            {dex && (
              <a href={dex.swap(t.address, q.address)} target="_blank" rel="noreferrer" className="btn-ghost px-4 py-2 text-sm">
                {dex.name} ↗
              </a>
            )}
            {dex?.chart && pool.data && (
              <a href={dex.chart(pool.data.pair)} target="_blank" rel="noreferrer" className="btn-ghost px-4 py-2 text-sm">
                Chart ↗
              </a>
            )}
            {pool.data && (
              <a href={`${explorer}/address/${pool.data.pair}`} target="_blank" rel="noreferrer" className="btn-ghost px-4 py-2 text-sm" title={pool.data.pair}>
                Pool {shortAddr(pool.data.pair)} ↗
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
          <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
            curve {progress.toFixed(1)}% · {fmtNum(priceOf(t.curve, q.decimals))} {q.symbol} per coin
          </div>
        </div>
      )}

      {user && (
        <div className="space-y-4 border-t border-white/10 pt-4">
          <p className="text-sm text-zinc-400">
            You hold {fmtTokens(held)} {t.symbol} here.
          </p>
          {!t.curve.graduated && held > 0n && (
            <LegacySell pad={pad} token={t.address} symbol={t.symbol} curve={t.curve} fees={t.fees} platformFeeBps={platformFeeBps} quote={q} balance={held} />
          )}
          <LegacyCashback pad={pad} token={t.address} quote={q} />
        </div>
      )}
    </div>
  );
}
