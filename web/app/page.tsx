"use client";

import Link from "next/link";
import { useState } from "react";
import { useTokens, useAppChain, isQuoteAsset, spotPrice, curveProgress } from "@/lib/hooks";
import { fmtEth } from "@/lib/format";
import { TokenCard } from "@/components/TokenCard";
import { TokenLogo } from "@/components/TokenLogo";
import { NotDeployedNotice } from "@/components/NotDeployedNotice";

type Sort = "newest" | "raised" | "progress";

export default function Explore() {
  const { tokens: allTokens, isLoading, count } = useTokens();
  const chain = useAppChain();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");

  // Pair assets (Notus pre-markets) live in their own section, not the grid.
  const preMarkets = allTokens.filter((t) => isQuoteAsset(chain.id, t.address));
  const tokens = allTokens.filter((t) => !isQuoteAsset(chain.id, t.address));

  const q = query.trim().toLowerCase();
  const filtered = tokens.filter(
    (t) =>
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.symbol.toLowerCase().includes(q) ||
      t.address.toLowerCase() === q
  );
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "raised") return b.curve.realEth > a.curve.realEth ? 1 : -1;
    if (sort === "progress") return b.curve.sold > a.curve.sold ? 1 : -1;
    return 0; // newest: keep hook order
  });

  return (
    <div className="space-y-10">
      <NotDeployedNotice />
      <section className="text-center space-y-4 py-6">
        <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-[0.15em] uppercase leading-snug">
          Launch your token
          <br />
          on {chain.name.replace(" Sepolia", "").replace(" Chain", "")}
        </h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          Transparent bonding curve: price rises with every buy, automatic
          graduation at 800M tokens sold, liquidity migrated to the DEX.
        </p>
        <Link
          href="/create"
          className="inline-block rounded-full bg-white px-6 py-2.5 font-semibold text-black hover:bg-zinc-200"
        >
          Create a token
        </Link>
      </section>

      {preMarkets.length > 0 && (
        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-mono text-sm font-semibold tracking-[0.2em] uppercase text-white">
              ◆ Pre-IPO markets
            </h2>
            <span className="text-[11px] text-zinc-600 text-right">
              Pair assets — hold them, launch against them, earn their fees
            </span>
          </div>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            {preMarkets.map((t) => (
              <Link
                key={t.address}
                href={`/token/${t.address}`}
                className="rounded-xl border border-zinc-700 bg-black p-4 hover:border-white transition-colors"
              >
                <div className="flex items-center gap-3">
                  <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={36} />
                  <div className="min-w-0">
                    <div className="font-mono font-bold truncate">{t.symbol}</div>
                    <div className="text-[11px] text-zinc-500 truncate">{t.name}</div>
                  </div>
                </div>
                <div className="mt-3 flex items-baseline justify-between gap-2">
                  <span className="text-sm text-zinc-300">{fmtEth(spotPrice(t.curve))} ETH</span>
                  <span className="font-mono text-[9px] tracking-widest uppercase border border-white rounded-full px-1.5 py-px text-white shrink-0">
                    Pair
                  </span>
                </div>
                <div className="mt-3 h-1 rounded bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-white"
                    style={{ width: `${Math.min(curveProgress(t.curve), 100)}%` }}
                  />
                </div>
              </Link>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-600">
            Synthetic community pre-markets: price discovery only — no equity, no backing, no
            affiliation. 80% of their trading fees goes to holders.
          </p>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <h2 className="font-mono text-sm font-semibold tracking-[0.2em] uppercase text-zinc-400">
            Explore {count > 0 && <span className="text-zinc-600">({tokens.length})</span>}
          </h2>
          <div className="flex gap-2 w-full sm:w-auto">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name / ticker"
              className="rounded-full bg-black border border-zinc-700 px-4 py-1.5 text-sm focus:border-white outline-none placeholder:text-zinc-600 flex-1 sm:flex-none sm:w-48 min-w-0"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded-full bg-black border border-zinc-700 px-3 py-1.5 text-sm focus:border-white outline-none text-zinc-300"
            >
              <option value="newest">Newest</option>
              <option value="raised">Most raised</option>
              <option value="progress">Curve progress</option>
            </select>
          </div>
        </div>

        {isLoading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-zinc-800 bg-black p-4 animate-pulse">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-lg bg-zinc-900" />
                  <div className="space-y-2">
                    <div className="h-3 w-24 rounded bg-zinc-900" />
                    <div className="h-2 w-12 rounded bg-zinc-900" />
                  </div>
                </div>
                <div className="mt-4 h-2 w-full rounded bg-zinc-900" />
                <div className="mt-3 h-1 w-full rounded bg-zinc-900" />
              </div>
            ))}
          </div>
        )}
        {!isLoading && sorted.length === 0 && (
          <p className="text-zinc-500">
            {q ? "No tokens match your search." : "No tokens yet. Be the first to launch."}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((t) => (
            <TokenCard key={t.address} token={t} />
          ))}
        </div>
      </section>
    </div>
  );
}
