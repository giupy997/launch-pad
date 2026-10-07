"use client";

import { useReadContracts } from "wagmi";
import { tokenLiveReads, tokenStaticReads } from "@/lib/tokenReads";
import {
  useLaunchpadAddress,
  curveProgress,
  priceOf,
  marketCapOf,
  parseCurve,
  parseMeta,
  useExplorer,
  useAppChain,
  quoteInfo,
  isQuoteAsset,
  IMMUTABLE,
} from "@/lib/hooks";
import { PRE_IPO_DISCLAIMER, isHiddenToken } from "@/lib/config";
import { fmtUnits, fmtTokens } from "@/lib/format";
import { TradeBox } from "@/components/TradeBox";
import { TokenHeader } from "@/components/TokenHeader";
import { useNow } from "@/lib/useNow";
import { PriceChart } from "@/components/PriceChart";
import { TradeFeed } from "@/components/TradeFeed";
import { useTrades, pricePoints } from "@/lib/events";
import { safeLink } from "@/lib/sanitize";
import { LiveStream } from "@/components/LiveStream";
import { CreatorPanel } from "@/components/CreatorPanel";
import { CashbackCard } from "@/components/CashbackCard";
import { MigrationNotice } from "@/components/MigrationNotice";
import { FeePanel } from "@/components/FeePanel";
import { parseFeeConfig, NO_TAX, treasuryPct } from "@/lib/curve";
import { useLtcPrice, fmtQuoteMoney, fmtQuoteMoneyNum, fmtUsd, isLtcQuote } from "@/lib/price";
import { poolMarketCapOf, poolPriceOf, usePool } from "@/lib/pool";
import { useHolders } from "@/lib/holders";
import { fmtNum } from "@/lib/format";
import { useAccount } from "wagmi";

/** A coin's page, rendered in the browser from the chain; page.tsx (server)
 *  prerenders the shell for every coin known at build time. */
export function TokenPage({ address }: { address: string }) {
  const token = address as `0x${string}`;
  const { address: user } = useAccount();
  const usd = useLtcPrice().data?.usd ?? null;
  const pad = useLaunchpadAddress() ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);
  const explorer = useExplorer();
  const chain = useAppChain();

  // name/symbol/fee mode never change — read once; only curve + metadata poll.
  // The same two lists the Explore cards read ahead of a tap (lib/tokenReads.ts).
  const { data: statics, isLoading: staticsLoading } = useReadContracts({
    contracts: tokenStaticReads(pad, token, chain.id),
    query: { ...IMMUTABLE },
  });
  const { data: dyn, isLoading: dynLoading } = useReadContracts({
    contracts: tokenLiveReads(pad, token, chain.id),
    query: { refetchInterval: 5_000 },
  });
  // a graduated coin's pool: its price and reserves replace the curve's frozen ones,
  // and its swaps join the trades, the chart and the volume
  const graduatedNow = dyn?.[0]?.status === "success" && (dyn[0].result as readonly unknown[])[4] === true;
  const pool = usePool(pad, token, chain.id, graduatedNow);
  // The trade history (feed, chart) is scanned once the page's own reads are
  // in and, for a graduated coin, once its pool is known: no scan competing
  // with the first paint, and no second scan when the pair turns up.
  const { data: tradeData, isPending: tradesPending } = useTrades(
    token,
    pool.data ? { token, pair: pool.data.pair, tokenIsZero: pool.data.tokenIsZero } : null,
    !!dyn && (!graduatedNow || !!pool.data || pool.none)
  );
  const holdersQ = useHolders(chain.id, token);
  const now = useNow(60_000);
  const isLoading = staticsLoading || dynLoading;

  if (isLoading || !statics || !dyn)
    return (
      <div className="grid gap-8 lg:grid-cols-[1fr_360px] animate-pulse">
        <div className="space-y-6">
          <div className="flex gap-4">
            <div className="w-[72px] h-[72px] rounded-lg bg-zinc-900" />
            <div className="space-y-2 pt-2">
              <div className="h-5 w-40 rounded bg-white/[0.06]" />
              <div className="h-3 w-24 rounded bg-white/[0.06]" />
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 rounded-lg bg-zinc-900" />
            ))}
          </div>
          <div className="h-40 rounded-xl bg-zinc-900" />
        </div>
        <div className="h-64 rounded-xl bg-zinc-900" />
      </div>
    );

  const [nameR, symbolR, feeModeR, feesR, feeBpsR, creatorShareR, holderShareR] = statics;
  const [curveR, metaR, burnPotR, liqPotR, burnedR] = dyn;
  const feesToHolders = feeModeR?.status === "success" ? (feeModeR.result as boolean) : false;
  const big = (r: { status: string; result?: unknown } | undefined, fallback = 0n) =>
    r?.status === "success" ? (r.result as bigint) : fallback;
  // pads before v9 know no fee configuration: no panel, and the launch-time choice tells the split
  const hasFees = feesR?.status === "success";
  const fees = hasFees
    ? parseFeeConfig(feesR.result)
    : { ...NO_TAX, creatorBps: feesToHolders ? 0 : 10_000, holdersBps: feesToHolders ? 10_000 : 0 };
  const platformFeeBps = big(feeBpsR, 100n);
  const treasury = treasuryPct(platformFeeBps, big(creatorShareR, 5_000n) + big(holderShareR, 3_000n));
  if (curveR.status !== "success" || (curveR.result as readonly unknown[])[0] === 0n) {
    return <p className="text-zinc-500">Token not found on this launchpad.</p>;
  }

  const name = nameR.status === "success" ? (nameR.result as string) : "?";
  const symbol = symbolR.status === "success" ? (symbolR.result as string) : "?";
  const curve = parseCurve(curveR.result);
  const meta =
    metaR.status === "success"
      ? parseMeta(metaR.result)
      : { logoURI: "", website: "", twitter: "", telegram: "", livestream: "", description: "" };
  const progress = curveProgress(curve);
  const q = quoteInfo(chain.id, curve.quoteAsset);
  const livePool = curve.graduated ? pool.data : undefined;
  const price = livePool ? poolPriceOf(livePool, q.decimals) : priceOf(curve, q.decimals);
  const mcap = livePool ? poolMarketCapOf(livePool, q.decimals) : marketCapOf(curve, q.decimals);
  // wallets holding the coin, counted from the chain by the route (contracts such as the pad and the pool taken off);
  // `partial` while the route is still reading an old coin's history: the count so far, growing
  const holders = holdersQ.data?.holders ?? null;
  const holdersPartial = holdersQ.data?.partial ?? false;
  // the day, from the coin's own trades: what traded, and the price a day ago
  // (the last trade before then when the history reaches back that far, else
  // the earliest trade known: the explore page's opening, the same figure)
  const dayAgo = now - 86_400;
  const trades = tradeData?.trades ?? [];
  const volume24h = tradeData ? trades.filter((x) => x.timestamp >= dayAgo).reduce((sum, x) => sum + x.eth, 0n) : undefined;
  const before = [...trades].reverse().find((x) => x.timestamp > 0 && x.timestamp < dayAgo);
  const open = before ?? trades.find((x) => x.timestamp > 0);
  const openPrice = open && open.tokens > 0n ? Number(open.eth) / 10 ** q.decimals / (Number(open.tokens) / 1e18) : null;
  const change24h = openPrice ? ((price - openPrice) / openPrice) * 100 : null;
  // when the coin was created: its first trade when the whole history is here, else the route's word (the mint's block)
  const launched = (tradeData && !tradeData.truncated && trades[0]?.timestamp) || holdersQ.data?.launched || null;
  // this token is itself a Notus pre-market (a registered pair asset)
  const isPreMarket = isQuoteAsset(chain.id, token);

  const links = [
    { label: "Website", href: safeLink(meta.website) },
    { label: "X", href: safeLink(meta.twitter) },
    { label: "Telegram", href: safeLink(meta.telegram) },
  ].filter((l): l is { label: string; href: string } => l.href !== null);

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px]">
      <div className="space-y-6 order-2 lg:order-1">
        {isHiddenToken(chain.id, token) && (
          <div className="rounded-xl border border-white/20 bg-black p-4 text-sm text-zinc-300">
            <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Not listed</div>
            Its creator withdrew this coin and relaunched it; it is not shown on the explore page. It still trades on its
            curve for whoever holds it.
          </div>
        )}
        <MigrationNotice token={token} symbol={symbol} compact />
        <TokenHeader
          token={token}
          name={name}
          symbol={symbol}
          logoURI={meta.logoURI}
          description={meta.description || undefined}
          disclaimer={q.synthetic || isPreMarket ? PRE_IPO_DISCLAIMER : null}
          badges={{ graduated: curve.graduated, preMarket: isPreMarket, rewards: feesToHolders, live: !!meta.livestream, preIpoQuote: q.preIpo }}
          creator={curve.creator}
          launched={launched}
          quote={{ symbol: q.symbol, decimals: q.decimals, logo: isLtcQuote(q.symbol) ? "/chains/litecoin.svg" : undefined }}
          usd={usd}
          mcap={mcap}
          price={price}
          change24h={change24h}
          volume24h={volume24h}
          buyTaxBps={fees.buyTaxBps}
          sellTaxBps={fees.sellTaxBps}
          poolFeeBps={curve.graduated ? 30 : null}
          explorer={explorer}
          links={links}
        />

        {meta.livestream && <LiveStream url={meta.livestream} />}

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat
            label="Price"
            value={`${fmtNum(price)} ${q.symbol}`}
            sub={`${usd && isLtcQuote(q.symbol) ? `${price * usd < 0.01 ? "<$0.01" : fmtUsd(price * usd)} per coin · ` : ""}${livePool ? "the pool's" : "on the curve"}`}
          />
          {curve.graduated ? (
            <Stat
              label="In the pool"
              value={livePool ? fmtQuoteMoney(livePool.quoteReserve, q.decimals, q.symbol, usd) : pool.none ? "—" : "…"}
              sub={livePool ? `${fmtUnits(livePool.quoteReserve, q.decimals)} ${q.symbol} · ${fmtTokens(livePool.tokenReserve)} ${symbol}` : undefined}
            />
          ) : (
            <Stat
              label="Raised"
              value={fmtQuoteMoney(curve.realEth, q.decimals, q.symbol, usd)}
              sub={usd && isLtcQuote(q.symbol) ? `${fmtUnits(curve.realEth, q.decimals)} ${q.symbol}` : undefined}
            />
          )}
          <Stat label="Sold" value={fmtTokens(curve.sold)} />
          <Stat
            label="Holders"
            value={holders === null ? (holdersQ.isPending ? "…" : "—") : `${holdersPartial ? "≥ " : ""}${holders.toLocaleString("en-US")}`}
            sub={holders === null ? undefined : holdersPartial ? "still counting" : "wallets with a balance"}
          />
          <Stat label="Curve" value={curve.graduated ? "Graduated" : `${progress.toFixed(1)}%`} />
        </div>

        <div>
          <div className="h-2 rounded bg-white/[0.08] overflow-hidden">
            <div
              className="h-full bg-white"
              style={{ width: `${Math.min(progress, 100)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {curve.graduated
              ? "The curve closed at 800M sold: its reserve seeded the pool, whose liquidity the pad keeps locked."
              : "Once 800M tokens are sold the curve closes and liquidity migrates to the DEX."}
          </p>
        </div>

        <PriceChart
          points={pricePoints(tradeData?.trades ?? [], q.decimals).map((p) => p * 1_000_000_000)}
          quoteSymbol={q.symbol}
          label="Market cap"
          format={(v) => fmtQuoteMoneyNum(v, q.symbol, usd)}
        />
        <TradeFeed
          trades={tradeData?.trades ?? []}
          symbol={symbol}
          quoteSymbol={q.symbol}
          quoteDecimals={q.decimals}
          truncated={tradeData?.truncated ?? false}
          loading={tradesPending}
        />
      </div>

      <div className="order-1 lg:order-2 space-y-6">
        <TradeBox token={token} symbol={symbol} curve={curve} fees={fees} platformFeeBps={platformFeeBps} treasury={treasury} />
        {hasFees && (
          <FeePanel
            token={token}
            symbol={symbol}
            fees={fees}
            platformFeeBps={platformFeeBps}
            treasury={treasury}
            burnPot={big(burnPotR)}
            liquidityPot={big(liqPotR)}
            burned={big(burnedR)}
            quoteSymbol={q.symbol}
            quoteDecimals={q.decimals}
            graduated={curve.graduated}
          />
        )}
        {feesToHolders && (
          <CashbackCard token={token} quoteSymbol={q.symbol} quoteDecimals={q.decimals} />
        )}
        {user && user.toLowerCase() === curve.creator.toLowerCase() && (
          <CreatorPanel token={token} meta={meta} />
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-sm">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-zinc-500 truncate">{sub}</div>}
    </div>
  );
}
