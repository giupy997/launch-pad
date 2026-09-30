"use client";

import Link from "next/link";
import { useState } from "react";
import { useTokens, useAppChain, isQuoteAsset } from "@/lib/hooks";
import { CHAIN_LABEL, QUOTE_ASSETS } from "@/lib/config";
import { TokenCard } from "@/components/TokenCard";
import { NotDeployedNotice } from "@/components/NotDeployedNotice";
import { MigrationNotice } from "@/components/MigrationNotice";

type Sort = "newest" | "raised" | "progress";

export default function Explore() {
  const { tokens: allTokens, isLoading, count } = useTokens();
  const chain = useAppChain();
  // what the coins are quoted in: the chain's first quote asset, else its gas coin
  const quote = QUOTE_ASSETS[chain.id]?.[0]?.symbol ?? chain.nativeCurrency.symbol;
  // the chain as the menu names it: Base goes by cbLTC, the coins' currency, hence "in"
  const label = CHAIN_LABEL[chain.id];
  const where = label ?? chain.name.replace(" Sepolia", "").replace(" Chain", "").replace(" Liteforge", "");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");

  // Pre-markets are pair assets, bought for users by the zap when they trade
  // a paired token — never listed as tokens to buy on their own.
  const tokens = allTokens.filter((t) => !t.isPreMarket && !isQuoteAsset(chain.id, t.address));

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
      <MigrationNotice />
      <section className="relative overflow-hidden rounded-3xl border border-white/10 px-6 py-14 sm:px-12 sm:py-20 card">
        {/* the light through the open head; black dissolves into the card */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-[70%] sm:w-[55%] bg-[url('/art/statue-beam.webp')] bg-cover bg-[45%_0%] sm:bg-[center_top] opacity-60 sm:opacity-75 mix-blend-screen"
          style={{ maskImage: "linear-gradient(to left, rgba(0,0,0,0.9), transparent 90%)", WebkitMaskImage: "linear-gradient(to left, rgba(0,0,0,0.9), transparent 90%)" }}
        />
        <div className="relative max-w-2xl space-y-6">
          <div className="pill fade-up">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_rgba(var(--accent),0.9)]" />
            {label ?? chain.name}{chain.testnet ? " · testnet" : ""}
          </div>
          <h1 className="display fade-up text-4xl sm:text-6xl leading-[1.02] text-white glow-text text-balance">
            Launch your token <br className="hidden sm:block" />
            {label ? "in" : "on"} <span className="font-light text-zinc-300">{where}</span>.
          </h1>
          <p className="fade-up-2 max-w-xl text-base sm:text-lg leading-relaxed text-zinc-400">
            A transparent bonding curve: the price rises with every buy, the coin graduates at 800M sold and its liquidity
            moves into a locked DEX pool. Quoted in {quote}, settled by the contract, no admin key.
          </p>
          {quote === "cbLTC" && (
            <p className="fade-up-2 max-w-xl text-sm leading-relaxed text-zinc-300">
              cbLTC is Litecoin wrapped by Coinbase: one LTC in custody for every token, proof of reserves published.
              Pay with ETH and the buy swaps it for you, or bring cbLTC —{" "}
              <Link href="/bridge" className="underline hover:text-white">how to get it</Link>.
            </p>
          )}
          <div className="fade-up-3 flex flex-wrap items-center gap-3 pt-1">
            <Link href="/create" className="btn-primary px-6 py-3 text-sm">
              Create a token
            </Link>
            <Link href="/about" className="btn-ghost px-5 py-3 text-sm">
              How it works
            </Link>
          </div>
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <h2 className="display text-3xl text-white">
            Tokens {count > 0 && <span className="text-zinc-600">({tokens.length})</span>}
          </h2>
          <div className="flex gap-2 w-full sm:w-auto">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name / ticker"
              className="rounded-full input px-4 py-1.5 text-sm focus:border-white outline-none placeholder:text-zinc-600 flex-1 sm:flex-none sm:w-48 min-w-0"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as Sort)}
              className="rounded-full input px-3 py-1.5 text-sm focus:border-white outline-none text-zinc-300"
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
