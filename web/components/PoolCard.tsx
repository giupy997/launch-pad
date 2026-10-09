"use client";

import { useReadContract } from "wagmi";
import { type PadVersion } from "@/lib/abi";
import { DEX_LINKS, MIGRATION_TARGET } from "@/lib/config";
import { NO_TAX, feesLine, parseFeeConfig, type FeeConfig } from "@/lib/curve";
import { fmtNum, fmtTokens, fmtUnits, shortAddr } from "@/lib/format";
import { IMMUTABLE, useAppChain, useExplorer, useLaunchpadAddress, usePadAbi, usePadVersion, ZERO_ADDRESS } from "@/lib/hooks";
import { poolMarketCapOf, poolPriceOf, usePool } from "@/lib/pool";
import { fmtQuoteMoney, fmtQuoteMoneyNum, isLtcQuote, useLtcPrice } from "@/lib/price";
import { PoolTrade } from "@/components/PoolTrade";

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** The trade box of a graduated coin: where it trades now, what its pool
 *  holds, that the pad keeps the liquidity locked, and the way to the DEX. */
export function PoolCard({
  token,
  symbol,
  quote,
  version: versionProp,
  fees: feesProp,
}: {
  token: `0x${string}`;
  symbol: string;
  quote: { symbol: string; decimals: number; address: `0x${string}` | null };
  /** the pad's generation; the chain's (PAD_VERSION) when the page does not say */
  version?: PadVersion;
  /** the coin's fee configuration, what its pool charges on v12; read here when the page does not hand it down */
  fees?: FeeConfig;
}) {
  const chain = useAppChain();
  const chainVersion = usePadVersion();
  const version = versionProp ?? chainVersion;
  const padAbi = usePadAbi();
  const pad = useLaunchpadAddress() ?? ZERO_ADDRESS;
  const explorer = useExplorer();
  const usd = useLtcPrice().data?.usd ?? null;
  const pool = usePool(pad, token, chain.id, true);
  const dex = DEX_LINKS[chain.id];
  const target = MIGRATION_TARGET[chain.id];
  const p = pool.data;
  const inDollars = !!usd && isLtcQuote(quote.symbol);

  // The coin's fees when they were not handed down (TradeBox's path): read
  // with the pad's own ABI, since feeConfig answers six fields on v11 and
  // seven on v12. The trade box waits for them rather than quote a v12 pool
  // gross. A six-field answer takes 0 for the pad's rate: a v11 pool pays the
  // pad nothing, and nothing here shows that figure. No feeConfig at all (a
  // pad before v9) is a coin without a tax.
  const ownFees = useReadContract({
    address: pad,
    abi: padAbi,
    functionName: "feeConfig",
    args: [token],
    chainId: chain.id,
    query: { enabled: feesProp === undefined, ...IMMUTABLE },
  });
  const fees: FeeConfig | undefined =
    feesProp ?? (ownFees.isError ? NO_TAX : ownFees.data !== undefined ? parseFeeConfig(ownFees.data, 0) : undefined);
  // what a v12 pool charges over its own 0.3%, as the closing line tells it; nothing on v11, or on a coin that charges nothing
  const charges =
    version === 12 && fees
      ? [
          fees.platformBps > 0 ? `the launchpad's ${pct(fees.platformBps)} a side` : null,
          fees.buyTaxBps > 0 || fees.sellTaxBps > 0 ? `the coin's own tax (${feesLine(fees)})` : null,
        ]
          .filter(Boolean)
          .join(" and ")
      : "";

  return (
    <div className="card p-5 h-fit space-y-4">
      <div>
        <div className="label">🎓 Graduated</div>
        <p className="mt-2 text-sm text-zinc-300">
          The curve sold out and its reserve seeded a pool on {dex?.name ?? "the DEX"}, paired with {quote.symbol}: that is
          where ${symbol} trades now. The pad holds the pool&apos;s liquidity and cannot take it out; it can only move it, whole,
          {target ? ` to ${target} with the coin.` : " with the coin when the pad migrates."}
        </p>
      </div>

      {p && (
        <dl className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-white/10 px-3 py-2">
            <dt className="label">In the pool</dt>
            <dd className="mt-0.5 font-semibold text-white">{fmtQuoteMoney(p.quoteReserve, quote.decimals, quote.symbol, usd)}</dd>
            <dd className="font-mono text-[10px] text-zinc-500">
              {inDollars && `${fmtUnits(p.quoteReserve, quote.decimals)} ${quote.symbol} · `}
              {fmtTokens(p.tokenReserve)} {symbol}
            </dd>
          </div>
          <div className="rounded-xl border border-white/10 px-3 py-2">
            <dt className="label">Pool price</dt>
            <dd className="mt-0.5 font-semibold text-white">{fmtQuoteMoneyNum(poolMarketCapOf(p, quote.decimals), quote.symbol, usd)} mcap</dd>
            <dd className="font-mono text-[10px] text-zinc-500">
              {fmtNum(poolPriceOf(p, quote.decimals))} {quote.symbol} per coin
            </dd>
          </div>
        </dl>
      )}
      {p && (
        <p className="text-xs text-zinc-500">
          {p.lockedPct}% of the pool&apos;s liquidity is the pad&apos;s, locked.
          {p.lockedPct < 99.99 && " The rest was added by others and is theirs to remove."}
        </p>
      )}
      {pool.isPending && <p className="text-xs text-zinc-500">Reading the pool…</p>}
      {pool.none && (
        <p className="text-xs text-zinc-500">
          The pad seeded no pool for this coin: its reserve is still on the pad, and anyone can call <code>migrate</code> on it
          to seed one.
        </p>
      )}

      {p && fees && <PoolTrade token={token} symbol={symbol} quote={quote} pool={p} fees={fees} version={version} />}

      <div className="flex flex-wrap gap-2">
        {dex && (
          <a
            href={dex.swap(token, quote.address)}
            target="_blank"
            rel="noreferrer"
            className="btn-ghost px-4 py-2 text-sm"
            title={charges ? "Trading there, set the slippage above what the pool charges: it is taken in coins" : undefined}
          >
            {dex.name} ↗
          </a>
        )}
        {dex?.chart && p && (
          <a href={dex.chart(p.pair)} target="_blank" rel="noreferrer" className="btn-ghost px-4 py-2 text-sm">
            Chart ↗
          </a>
        )}
        {p && (
          <a href={`${explorer}/address/${p.pair}`} target="_blank" rel="noreferrer" className="btn-ghost px-4 py-2 text-sm" title={p.pair}>
            Pool {shortAddr(p.pair)} ↗
          </a>
        )}
      </div>

      {/* what a swap here pays: on v12 the launchpad's rate and the coin's tax go on, in coins, past
          graduation; a v11 pool pays nothing to the pad or the coin, and the text says so as before */}
      <p className="text-xs text-zinc-500">
        {charges ? (
          <>
            Swaps here pay {charges}, like the curve did: taken in coins, and sold for {quote.symbol} by anyone&apos;s{" "}
            <a href="#fees" className="underline">
              harvest
            </a>
            . The pool&apos;s own 0.3% stays with its liquidity, which the pad holds: it stays in the pool.
          </>
        ) : (
          <>
            Swaps here go straight to the pool through its router, with no fee of the launchpad&apos;s: the curve&apos;s fees ended
            with it. The pool&apos;s own 0.3% goes to its liquidity, which the pad holds: it stays in the pool.
          </>
        )}
      </p>
    </div>
  );
}
