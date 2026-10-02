"use client";

import { use } from "react";

import { useReadContracts } from "wagmi";
import { launchpadAbi, launchTokenAbi } from "@/lib/abi";
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
import { fmtUnits, fmtTokens, shortAddr } from "@/lib/format";
import { TradeBox } from "@/components/TradeBox";
import { TokenLogo } from "@/components/TokenLogo";
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
import { useLtcPrice, fmtQuoteMoney, fmtQuoteMoneyNum, isLtcQuote } from "@/lib/price";
import { fmtNum } from "@/lib/format";
import { useAccount } from "wagmi";

export default function TokenPage({ params }: { params: Promise<{ address: string }> }) {
  const { address: addressParam } = use(params);
  const token = addressParam as `0x${string}`;
  const { address: user } = useAccount();
  const { data: tradeData, isPending: tradesPending } = useTrades(token);
  const ltcUsd = useLtcPrice().data?.usd ?? null;
  const pad = useLaunchpadAddress() ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);
  const explorer = useExplorer();
  const chain = useAppChain();
  // dollars only where the quote is LTC for real: a testnet's zkLTC is worth nothing
  const usd = chain.testnet ? null : ltcUsd;

  // name/symbol/fee mode never change — read once; only curve + metadata poll.
  const { data: statics, isLoading: staticsLoading } = useReadContracts({
    contracts: [
      { address: token, abi: launchTokenAbi, functionName: "name" },
      { address: token, abi: launchTokenAbi, functionName: "symbol" },
      { address: pad, abi: launchpadAbi, functionName: "feesToHolders", args: [token] },
      { address: pad, abi: launchpadAbi, functionName: "feeConfig", args: [token] },
      { address: pad, abi: launchpadAbi, functionName: "feeBps" },
      { address: pad, abi: launchpadAbi, functionName: "creatorFeeShareBps" },
      { address: pad, abi: launchpadAbi, functionName: "holderCashbackBps" },
    ],
    query: { ...IMMUTABLE },
  });
  const { data: dyn, isLoading: dynLoading } = useReadContracts({
    contracts: [
      { address: pad, abi: launchpadAbi, functionName: "curves", args: [token] },
      { address: pad, abi: launchpadAbi, functionName: "tokenMetadata", args: [token] },
      { address: pad, abi: launchpadAbi, functionName: "burnPot", args: [token] },
      { address: pad, abi: launchpadAbi, functionName: "liquidityPot", args: [token] },
      { address: pad, abi: launchpadAbi, functionName: "burned", args: [token] },
    ],
    query: { refetchInterval: 5_000 },
  });
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
        <div className="flex items-start gap-4">
          <TokenLogo uri={meta.logoURI} symbol={symbol} size={72} />
          <div>
            <h1 className="text-3xl font-bold">
              {name}{" "}
              <span className="font-mono text-lg text-zinc-400">${symbol}</span>
              {curve.graduated && (
                <span className="ml-3 font-mono text-xs tracking-widest uppercase border border-white rounded-full px-2 py-0.5 align-middle">
                  Graduated
                </span>
              )}
              {isPreMarket && (
                <span
                  title="Registered pair asset: new tokens can launch against it"
                  className="ml-3 font-mono text-xs tracking-widest uppercase bg-white text-black rounded-full px-2 py-0.5 align-middle"
                >
                  ◆ Pre-IPO market
                </span>
              )}
              {feesToHolders && (
                <span
                  title={`${fees.holdersBps / 100}% of the fee pot goes to holders as cashback`}
                  className="ml-3 font-mono text-xs tracking-widest uppercase border border-white rounded-full px-2 py-0.5 align-middle"
                >
                  ✦ Rewards
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              <a href={`${explorer}/address/${token}`} target="_blank" className="underline">
                {shortAddr(token)}
              </a>{" "}
              · creator {shortAddr(curve.creator)} · paired with{" "}
              <span className="text-zinc-300">{q.symbol}</span>
              {q.preIpo && (
                <span className="ml-2 font-mono text-[10px] tracking-widest uppercase border border-white rounded-full px-2 py-0.5 text-white">
                  Pre-IPO
                </span>
              )}
            </p>
            {(q.synthetic || isPreMarket) && (
              <p className="mt-1 text-[11px] text-zinc-600">{PRE_IPO_DISCLAIMER}</p>
            )}
            {meta.description && (
              <p className="mt-2 text-sm text-zinc-400 max-w-lg">{meta.description}</p>
            )}
            {links.length > 0 && (
              <div className="mt-2 flex gap-2">
                {links.map((l) => (
                  <a
                    key={l.label}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-full border border-white/15 px-3 py-1 text-xs text-zinc-300 hover:border-white hover:text-white"
                  >
                    {l.label} ↗
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {meta.livestream && <LiveStream url={meta.livestream} />}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat
            label="Market cap"
            value={fmtQuoteMoneyNum(marketCapOf(curve, q.decimals), q.symbol, usd)}
            sub={`${usd && isLtcQuote(q.symbol) ? `${fmtNum(marketCapOf(curve, q.decimals))} ${q.symbol} · ` : ""}${fmtNum(priceOf(curve, q.decimals))} ${q.symbol} per coin`}
          />
          <Stat
            label="Raised"
            value={fmtQuoteMoney(curve.realEth, q.decimals, q.symbol, usd)}
            sub={usd && isLtcQuote(q.symbol) ? `${fmtUnits(curve.realEth, q.decimals)} ${q.symbol}` : undefined}
          />
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
            Once 800M tokens are sold the curve closes and liquidity migrates to the DEX.
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
