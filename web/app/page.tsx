"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useTokens, useAppChain, isQuoteAsset, useLaunchpadAddress, ZERO_ADDRESS, quoteInfo, marketCapOf, priceOf, curveProgress } from "@/lib/hooks";
import { useVolumes, useTrades, pricePoints } from "@/lib/events";
import { usePools } from "@/lib/pool";
import { useLtcPrice } from "@/lib/price";
import { useHolders } from "@/lib/holders";
import { CHAIN_LABEL, LAUNCHPAD_ADDRESS, MIGRATION_TARGET, QUOTE_ASSETS, VISIBLE_CHAINS } from "@/lib/config";
import { WarmTokens } from "@/components/WarmTokens";
import { NotDeployedNotice } from "@/components/NotDeployedNotice";
import { MigrationNotice } from "@/components/MigrationNotice";
import { SeasonStrip } from "@/components/SeasonStrip";
import { ExploreView } from "@/components/explore/ExploreView";
import type { Coin } from "@/components/explore/types";

/** quote wei per token wei, as quote units per whole coin */
const unitPrice = (eth: bigint, tokens: bigint, decimals: number) =>
  tokens > 0n ? Number(eth) / 10 ** decimals / (Number(tokens) / 1e18) : null;

export default function Explore() {
  const { tokens: allTokens, isLoading, isError } = useTokens();
  const chain = useAppChain();
  const pad = useLaunchpadAddress() ?? ZERO_ADDRESS;
  // Pre-markets are pair assets, bought for users by the zap when they trade
  // a paired token — never listed as tokens to buy on their own.
  const tokens = useMemo(() => allTokens.filter((t) => !t.isPreMarket && !isQuoteAsset(chain.id, t.address)), [allTokens, chain.id]);
  // the graduated coins' pools: their swaps count in the day's volume, their reserves price them
  const graduatedAddrs = useMemo(() => tokens.filter((t) => t.curve.graduated).map((t) => t.address), [tokens]);
  const { pools, reserves, ready: poolsReady } = usePools(pad, graduatedAddrs, chain.id);
  const { data: volumes } = useVolumes(pools, !isLoading && poolsReady);
  // money in dollars wherever the quote is LTC in one of its forms (cbLTC, zkLTC): a
  // market cap reads as a market cap, the quote amount stays beneath it
  const usd = useLtcPrice().data?.usd ?? null;
  // what the coins are quoted in: the chain's first quote asset, else its gas coin
  const quoteAsset = QUOTE_ASSETS[chain.id]?.[0];
  const quote = { symbol: quoteAsset?.symbol ?? chain.nativeCurrency.symbol, decimals: quoteAsset?.decimals ?? 18 };
  // the chain as the menu names it: Base goes by cbLTC, the coins' currency, hence "in"
  const label = CHAIN_LABEL[chain.id];
  const where = label ?? chain.name.replace(" Sepolia", "").replace(" Chain", "").replace(" Liteforge", "");
  // a v8 pad: its coins move to another chain when the day comes
  const target = MIGRATION_TARGET[chain.id];

  // every figure the sections rank by, once per coin, and only when something they rest on changed
  const coins: Coin[] = useMemo(
    () =>
      tokens.map((t) => {
    const q = quoteInfo(chain.id, t.curve.quoteAsset);
    const key = t.address.toLowerCase();
    const r = t.curve.graduated ? reserves[key] : undefined;
    const poolPrice = r ? unitPrice(r.quoteReserve, r.tokenReserve, q.decimals) : null;
    const price = poolPrice ?? priceOf(t.curve, q.decimals);
    const mcap = poolPrice !== null ? poolPrice * 1_000_000_000 : marketCapOf(t.curve, q.decimals);
    const day = volumes?.days[key];
    const open = day ? unitPrice(day.first.eth, day.first.tokens, q.decimals) : null;
    return {
      token: t,
      stats: {
        mcap,
        price,
        volume24h: volumes ? (volumes.byToken[key] ?? 0n) : undefined,
        change24h: open ? ((price - open) / open) * 100 : null,
        lastTrade: day?.last.timestamp || null,
        progress: t.curve.graduated ? 100 : curveProgress(t.curve),
      },
      quote: { symbol: q.symbol, decimals: q.decimals },
    };
      }),
    [tokens, reserves, volumes, chain.id]
  );

  // the king: the most traded coin of the day, on its curve or graduated (then by progress, then by size);
  // its holders and its day's price line, pool swaps included once it has a pool
  const king =
    [...coins].sort(
      (a, b) =>
        Number((b.stats.volume24h ?? 0n) - (a.stats.volume24h ?? 0n)) || b.stats.progress - a.stats.progress || b.stats.mcap - a.stats.mcap
    )[0] ?? null;
  const kingPool = king ? (pools.find((x) => x.token.toLowerCase() === king.token.address.toLowerCase()) ?? null) : null;
  const kingHolders = useHolders(chain.id, king?.token.address ?? ZERO_ADDRESS, !!king);
  const kingTrades = useTrades(king?.token.address ?? ZERO_ADDRESS, kingPool, !!king && (!king.token.curve.graduated || !!kingPool));
  const kingPoints = pricePoints(kingTrades.data?.trades ?? [], king?.quote.decimals ?? quote.decimals);

  return (
    <div className="space-y-10">
      <NotDeployedNotice />
      <MigrationNotice />
      <SeasonStrip />
      <section className="relative overflow-hidden rounded-3xl border border-white/10 px-6 py-10 sm:px-12 sm:py-12 card">
        {/* the light through the open head; black dissolves into the card */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-[70%] sm:w-[55%] bg-[url('/art/statue-beam.webp')] bg-cover bg-[45%_0%] sm:bg-[center_top] opacity-60 sm:opacity-75 mix-blend-screen"
          style={{ maskImage: "linear-gradient(to left, rgba(0,0,0,0.9), transparent 90%)", WebkitMaskImage: "linear-gradient(to left, rgba(0,0,0,0.9), transparent 90%)" }}
        />
        <div className="relative max-w-2xl space-y-5">
          <div className="pill fade-up">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_rgba(var(--accent),0.9)]" />
            {label ?? chain.name}
            {chain.testnet ? " · testnet" : ""}
          </div>
          <h1 className="display fade-up text-4xl sm:text-5xl leading-[1.02] text-white glow-text text-balance">
            Launch your token {label ? "in" : "on"} <span className="font-light text-zinc-300">{where}</span>.
          </h1>
          <p className="fade-up-2 max-w-xl text-base leading-relaxed text-zinc-400">
            A transparent bonding curve: the price rises with every buy, the coin graduates at 800M sold and its liquidity
            moves into a locked DEX pool. Quoted in {quote.symbol}, settled by the contract; the only key is a 24-hour timelock.
            {target && (
              <>
                {" "}
                <span className="text-zinc-300">Every coin launched here moves to {target}</span> the day it goes live.{" "}
                <Link href="/about#migration" className="underline hover:text-white">
                  How
                </Link>
                .
              </>
            )}
          </p>
          <div className="fade-up-3 flex flex-wrap items-center gap-3 pt-1">
            <Link href="/create" className="btn-primary px-6 py-3 text-sm">
              Create a token
            </Link>
            <Link href="/about" className="btn-ghost px-5 py-3 text-sm">
              How it works
            </Link>
            {quote.symbol === "cbLTC" && (
              <Link href="/bridge" className="btn-ghost px-5 py-3 text-sm">
                Get cbLTC
              </Link>
            )}
          </div>
        </div>
      </section>

      <ExploreView
        coins={coins}
        usd={usd}
        loading={isLoading}
        error={isError}
        king={
          king
            ? {
                coin: king,
                holders: kingHolders.isPending ? undefined : (kingHolders.data?.holders ?? null),
                holdersPartial: kingHolders.data?.partial ?? false,
                points: kingPoints,
              }
            : null
        }
      />

      {/* once this chain's list is in, the other chains' lists are read ahead, so a switch shows them at once */}
      {!isLoading &&
        VISIBLE_CHAINS.filter((c) => c.id !== chain.id && LAUNCHPAD_ADDRESS[c.id]).map((c) => <WarmTokens key={c.id} chainId={c.id} />)}

      {target && (
        /* the bust in the water: where the coins go next */
        <section className="relative overflow-hidden rounded-3xl border border-white/10 card">
          {/* phones stack it, the statue above the words; wider screens put them side by side */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-[url('/art/statue-water.webp')] bg-cover bg-[center_30%] opacity-80 mix-blend-screen sm:hidden"
            style={{ maskImage: "linear-gradient(to bottom, rgba(0,0,0,0.95) 45%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,0.95) 45%, transparent 100%)" }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-0 hidden w-[58%] bg-[url('/art/statue-water.webp')] bg-cover bg-[center_42%] opacity-75 mix-blend-screen sm:block"
            style={{ maskImage: "linear-gradient(to right, rgba(0,0,0,0.95) 55%, transparent 100%)", WebkitMaskImage: "linear-gradient(to right, rgba(0,0,0,0.95) 55%, transparent 100%)" }}
          />
          <div className="relative max-w-xl space-y-5 px-6 pb-12 pt-56 sm:ml-[46%] sm:px-12 sm:py-20">
            <div className="pill">Road to LitVM</div>
            <h2 className="display text-3xl sm:text-5xl leading-[1.05] text-white text-balance">
              Priced in {quote.symbol}.
              <br />
              Carried to LitVM.
            </h2>
            <p className="text-sm sm:text-base leading-relaxed text-zinc-400">
              Every coin here, on its curve or graduated into its pool, is re-created on {target} the day it goes live: same holders,
              same price, a real pool. A freeze announced a day ahead makes the snapshot final; the move itself takes a few hours.
            </p>
            <div className="flex flex-wrap gap-3 pt-1">
              <Link href="/about#migration" className="btn-ghost px-5 py-2.5 text-sm">
                How the migration works
              </Link>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
