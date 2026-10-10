"use client";

import { useState } from "react";
import { TokenLogo } from "@/components/TokenLogo";
import { Change } from "@/components/explore/Change";
import { copyText } from "@/lib/clipboard";
import { fmtAgo, fmtNum, shortAddr } from "@/lib/format";
import { fmtQuoteMoney, fmtQuoteMoneyNum, isLtcQuote } from "@/lib/price";
import { useNow } from "@/lib/useNow";

export type TokenHeaderProps = {
  token: `0x${string}`;
  name: string;
  symbol: string;
  logoURI: string;
  description?: string;
  disclaimer?: string | null;
  badges: { graduated: boolean; preMarket: boolean; rewards: boolean; live: boolean; preIpoQuote: boolean };
  creator: `0x${string}`;
  /** when the coin was created, unix seconds; null while unknown */
  launched: number | null;
  quote: { symbol: string; decimals: number; logo?: string };
  usd: number | null;
  mcap: number;
  price: number;
  change24h: number | null;
  /** the last day's trading in quote wei; undefined while unknown */
  volume24h: bigint | undefined;
  /** the coin's tax each way; undefined while it is not read yet */
  buyTaxBps: number | undefined;
  sellTaxBps: number | undefined;
  /** the pool's fee once graduated (Uniswap v2: 30 bps); null on the curve */
  poolFeeBps: number | null;
  /** the launchpad's rate on the pool, basis points: on v12 the coin's platformBps, taken in coins with
   *  its tax on every swap there; null while it is not read yet; 0 or absent where the pool pays the
   *  pad nothing (v11) */
  poolPlatformBps?: number | null;
  explorer: string;
  links: { label: string; href: string }[];
};

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** The top of a coin's page: who it is on the left, what it is worth on the
 *  right, and underneath a bar of facts with the contract address first,
 *  there to be recognised and copied in one tap. */
export function TokenHeader(p: TokenHeaderProps) {
  const now = useNow(60_000);
  const inDollars = !!p.usd && isLtcQuote(p.quote.symbol);
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-start gap-4">
          <TokenLogo uri={p.logoURI} symbol={p.symbol} size={64} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="display text-3xl leading-none text-white sm:text-4xl">${p.symbol}</h1>
              {p.badges.graduated && <Badge>♛ Graduated</Badge>}
              {p.badges.preMarket && (
                <Badge solid title="Registered pair asset: new tokens can launch against it">
                  ◆ Pre-IPO market
                </Badge>
              )}
              {p.badges.rewards && <Badge title="Part of the fee pot goes to holders as cashback">✦ Rewards</Badge>}
              {p.badges.live && <Badge>● Live</Badge>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
              <span className="truncate">{p.name}</span>
              {p.links.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs text-zinc-300 transition-colors duration-150 hover:border-white hover:text-white"
                >
                  {l.label} ↗
                </a>
              ))}
            </div>
          </div>
        </div>
        <div className="shrink-0 text-left sm:text-right">
          <div className="display text-3xl leading-none text-white sm:text-4xl">
            {fmtQuoteMoneyNum(p.mcap, p.quote.symbol, p.usd)}
            <span className="ml-2 font-sans text-sm font-normal text-zinc-500">mcap</span>
          </div>
          <div className="mt-2 flex items-center gap-2 text-sm sm:justify-end">
            <Change pct={p.change24h} />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-0.5 font-mono text-[11px] text-zinc-200">
              {p.quote.logo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.quote.logo} alt="" width={12} height={12} className="rounded-full" />
              )}
              {p.quote.symbol}
            </span>
            {p.badges.preIpoQuote && <Badge>Pre-IPO</Badge>}
          </div>
          <div className="mt-1.5 font-mono text-[11px] text-zinc-500">
            {inDollars ? `${fmtNum(p.mcap)} ${p.quote.symbol} · ` : ""}
            {fmtNum(p.price)} {p.quote.symbol} per coin
          </div>
        </div>
      </div>

      {/* the facts, the contract address first */}
      <div className="card flex flex-wrap items-center gap-x-5 gap-y-2.5 px-4 py-3 text-xs">
        <Fact label="Contract">
          <CopyChip text={p.token} />
          <ExplorerLink href={`${p.explorer}/address/${p.token}`} />
        </Fact>
        <Fact label="Creator">
          <CopyChip text={p.creator} />
          <ExplorerLink href={`${p.explorer}/address/${p.creator}`} />
        </Fact>
        <Fact label="Launched">
          <span className="text-zinc-200">{p.launched ? fmtAgo(p.launched, now) : "—"}</span>
        </Fact>
        <Fact label="Buy tax">
          <span className="text-zinc-200">{p.buyTaxBps === undefined ? "…" : pct(p.buyTaxBps)}</span>
        </Fact>
        <Fact label="Sell tax">
          <span className="text-zinc-200">{p.sellTaxBps === undefined ? "…" : pct(p.sellTaxBps)}</span>
        </Fact>
        {p.poolFeeBps !== null && (
          <Fact label="Pool fee">
            <span className="text-zinc-200">{pct(p.poolFeeBps)}</span>
            {p.poolPlatformBps === null ? (
              <span className="text-zinc-500">+ … launchpad + tax</span>
            ) : (
              !!p.poolPlatformBps && (
                <span
                  className="text-zinc-500"
                  title={`The pool's ${pct(p.poolFeeBps)} stays with its liquidity; the launchpad's ${pct(p.poolPlatformBps)} and the coin's tax are taken in coins on every swap there`}
                >
                  + {pct(p.poolPlatformBps)} launchpad + tax
                </span>
              )
            )}
          </Fact>
        )}
        <Fact label="24h volume">
          <span className="text-zinc-200">
            {p.volume24h === undefined ? "…" : p.volume24h === 0n ? "—" : fmtQuoteMoney(p.volume24h, p.quote.decimals, p.quote.symbol, p.usd)}
          </span>
        </Fact>
      </div>

      {p.description && <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">{p.description}</p>}
      {p.disclaimer && <p className="text-[11px] text-zinc-600">{p.disclaimer}</p>}
    </header>
  );
}

function Badge({ children, solid, title }: { children: React.ReactNode; solid?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={`rounded-full px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase ${
        solid ? "bg-white text-black" : "border border-white/40 text-zinc-200"
      }`}
    >
      {children}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">{label}</span>
      {children}
    </span>
  );
}

/** An address in short, copied whole on a tap. */
function CopyChip({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={text}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className="inline-flex items-center gap-1.5 rounded-md bg-white/[0.06] px-2 py-1 font-mono text-[11px] text-zinc-100 transition-colors duration-150 hover:bg-white/[0.12]"
    >
      {shortAddr(text)}
      {copied ? (
        <span className="text-white" aria-hidden>
          ✓
        </span>
      ) : (
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-400" aria-hidden>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
        </svg>
      )}
      <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function ExplorerLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="View on the explorer"
      className="rounded-md p-1 text-zinc-500 transition-colors duration-150 hover:bg-white/[0.08] hover:text-white"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <path d="M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" />
        <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
      </svg>
      <span className="sr-only">Explorer</span>
    </a>
  );
}
