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
  RETRY_MS,
  chainAnswered,
  usePadVersion,
} from "@/lib/hooks";
import type { PadVersion } from "@/lib/abi";
import Link from "next/link";
import { BLOCK_SECONDS, LEGACY_LAUNCHPADS, PRE_IPO_DISCLAIMER, isHiddenToken } from "@/lib/config";
import { fmtUnits, fmtTokens } from "@/lib/format";
import { TradeBox } from "@/components/TradeBox";
import { PoolCard } from "@/components/PoolCard";
import { TokenHeader } from "@/components/TokenHeader";
import { useNow } from "@/lib/useNow";
import { PriceChart } from "@/components/PriceChart";
import { TokenActivity } from "@/components/TokenActivity";
import { useTrades, pricePoints, withEstimatedTimes } from "@/lib/events";
import { safeLink } from "@/lib/sanitize";
import { LiveStream } from "@/components/LiveStream";
import { CreatorPanel } from "@/components/CreatorPanel";
import { CashbackCard } from "@/components/CashbackCard";
import { MigrationNotice } from "@/components/MigrationNotice";
import { FeePanel } from "@/components/FeePanel";
import { parseFeeConfig, NO_TAX, treasuryPct, treasuryPctV11 } from "@/lib/curve";
import { useLtcPrice, fmtQuoteMoney, fmtQuoteMoneyNum, fmtUsd, isLtcQuote } from "@/lib/price";
import { poolMarketCapOf, poolPriceOf, usePool } from "@/lib/pool";
import { useHolders } from "@/lib/holders";
import { fmtNum } from "@/lib/format";
import { useAccount } from "wagmi";

/** Whether the chain has answered the entries of tokenStaticReads a trade's price rests on:
 *  the coin's feeConfig (its tax; on v12 the launchpad fee too), and on v11 the pad's fee and
 *  its split. Not name or symbol, and a revert counts (a coin older than fee configurations
 *  has none): a page opened on an address that is no coin of the pad would ask for good. */
const FEE_ENTRIES: Record<PadVersion, readonly number[]> = { 12: [3], 11: [3, 4, 5, 6] };
function feesAnswered(data: unknown, version: PadVersion): boolean {
  const reads = data as readonly { status?: unknown; error?: unknown }[] | undefined;
  return !!reads && FEE_ENTRIES[version].every((i) => chainAnswered(reads[i]));
}

/** A coin's page, rendered in the browser from the chain; page.tsx (server)
 *  prerenders the shell for every coin known at build time. */
export function TokenPage({ address }: { address: string }) {
  const token = address as `0x${string}`;
  const { address: user } = useAccount();
  const usd = useLtcPrice().data?.usd ?? null;
  const pad = useLaunchpadAddress() ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);
  const explorer = useExplorer();
  const chain = useAppChain();
  const version = usePadVersion();

  // name/symbol/fee mode never change — read once; only curve + metadata poll.
  // The same two lists the Explore cards read ahead of a tap (lib/tokenReads.ts).
  // A multicall resolves even when the RPC failed, each entry a failure, and the
  // fee entries hold up Buy and Sell: until they answer they are asked again,
  // at once if the cache (a card's prefetch, a failed first visit) holds no answer.
  const { data: statics, isLoading: staticsLoading } = useReadContracts({
    contracts: tokenStaticReads(pad, token, chain.id, version),
    query: {
      ...IMMUTABLE,
      refetchInterval: (q) => (feesAnswered(q.state.data, version) ? false : RETRY_MS),
      refetchOnMount: (q) => (feesAnswered(q.state.data, version) ? false : "always"),
    },
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
    pool.data ? { token, pair: pool.data.pair, migrator: pool.data.migrator, tokenIsZero: pool.data.tokenIsZero } : null,
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
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
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
  const read = (r: { status: string; result?: unknown } | undefined) => (r?.status === "success" ? (r.result as bigint) : undefined);
  // the pad's rate: v11's platform fee, and what a six-field feeConfig falls back to
  const padFeeBps = read(feeBpsR);
  // pads before v9 know no fee configuration: no panel, and the launch-time choice tells the split
  const hasFees = feesR?.status === "success";
  const fees = hasFees
    ? parseFeeConfig(feesR.result, Number(padFeeBps ?? 0n))
    : { ...NO_TAX, platformBps: Number(padFeeBps ?? 0n), creatorBps: feesToHolders ? 0 : 10_000, holdersBps: feesToHolders ? 10_000 : 0 };
  // Whether the page knows what a trade pays, from the chain only: on v12 the coin's own feeConfig
  // (every v12 coin has one, so a failed read is a failed read, not an older coin); on v11 the pad's
  // fee. Until then nothing quotes and the rates say "…".
  // On v11 the coin's tax rides the same feeConfig read: a revert there is an older coin with
  // none, but a failed transport is not yet an answer, and a trade must not price at no tax.
  const feesKnown = version === 12 ? hasFees : padFeeBps !== undefined && chainAnswered(feesR);
  const taxKnown = version === 12 ? hasFees : chainAnswered(feesR);
  // the rate the coin trades at and the treasury's cut of it: on v12 both are the coin's own
  // (feeConfig's seventh field, whole to the treasury); on v11 the pad's fee, less the pot's share
  const platformFeeBps = !feesKnown ? undefined : version === 12 ? BigInt(fees.platformBps) : padFeeBps;
  const [creatorShareBps, holderShareBps] = [read(creatorShareR), read(holderShareR)];
  const treasury =
    platformFeeBps === undefined
      ? "…"
      : version === 12
        ? treasuryPct(fees.platformBps)
        : creatorShareBps !== undefined && holderShareBps !== undefined
          ? treasuryPctV11(platformFeeBps, creatorShareBps + holderShareBps)
          : "…";
  if (curveR.status !== "success" || (curveR.result as readonly unknown[])[0] === 0n) {
    return (
      <p className="text-zinc-500">
        Token not found on this launchpad.
        {!!LEGACY_LAUNCHPADS[chain.id]?.length && (
          <>
            {" "}
            A coin from an earlier launchpad on this chain is on the{" "}
            <Link href="/legacy" className="underline">
              legacy page
            </Link>
            .
          </>
        )}
      </p>
    );
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
  // who holds the coin, counted from the chain by the route (contracts such as the pad and the pool taken off the
  // count, named in the list); `partial` while the route is still reading an old coin's history: so far, growing
  const holders = holdersQ.data?.holders ?? null;
  const holdersPartial = holdersQ.data?.partial ?? false;
  // the day, from the coin's own trades, each placed in time (one without its
  // block's time by its distance from one that has it): what traded, and the
  // change since the day's first trade, the explore page's figure
  const dayAgo = now - 86_400;
  const trades = withEstimatedTimes(tradeData?.trades ?? [], BLOCK_SECONDS[chain.id] ?? 2);
  const day = trades.filter((x) => x.timestamp >= dayAgo);
  const volume24h = tradeData ? day.reduce((sum, x) => sum + x.eth, 0n) : undefined;
  const open = day[0];
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
          buyTaxBps={taxKnown ? fees.buyTaxBps : undefined}
          sellTaxBps={taxKnown ? fees.sellTaxBps : undefined}
          poolFeeBps={curve.graduated ? 30 : null}
          poolPlatformBps={version !== 12 ? 0 : feesKnown ? fees.platformBps : null}
          explorer={explorer}
          links={links}
        />

        {meta.livestream && <LiveStream url={meta.livestream} />}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
        <TokenActivity
          trades={{ trades, symbol, quoteSymbol: q.symbol, quoteDecimals: q.decimals, truncated: tradeData?.truncated ?? false, loading: tradesPending }}
          holders={{
            list: holdersQ.data?.top ?? [],
            total: holders,
            partial: holdersPartial,
            loading: holdersQ.isPending,
            symbol,
            // the addresses the page knows by name; the pad and the pool after the creator, so a contract keeps its name
            labels: {
              [curve.creator.toLowerCase()]: "Creator",
              [pad.toLowerCase()]: "Bonding curve",
              ...(pool.data ? { [pool.data.pair.toLowerCase()]: "Liquidity pool" } : {}),
            },
            explorer,
          }}
        />
      </div>

      <div className="order-1 lg:order-2 space-y-6">
        {/* a graduated coin trades in its pool: the card gets the coin's fees and the pad's generation
            from here, since on v12 the pool charges them in coins and the quotes must be net of that;
            fees the page could not read it reads again itself, and waits for them */}
        {curve.graduated ? (
          <PoolCard token={token} symbol={symbol} quote={q} version={version} fees={feesKnown ? fees : undefined} />
        ) : (
          <TradeBox token={token} symbol={symbol} curve={curve} fees={fees} platformFeeBps={platformFeeBps} treasury={treasury} />
        )}
        {hasFees && (
          <FeePanel
            token={token}
            symbol={symbol}
            fees={fees}
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
