"use client";

import Link from "next/link";
import { useState } from "react";
import { CURVE_SUPPLY } from "@/lib/litecoin/ledger";
import { LTC_NETWORK, coinVolume, fmtLtc, fmtMcap, fmtVolume, marketCapLtc, shortAddr, txLink, useLitecoinState, useLtcPrice, type LCoin, type LState } from "@/lib/litecoin/client";
import { FrozenNotice } from "@/components/litecoin/FrozenNotice";
import { TokenLogo } from "@/components/TokenLogo";

export default function LitecoinExplore() {
  const { data: state, isLoading } = useLitecoinState();
  const usd = useLtcPrice().data?.usd ?? null;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const coins = [...(state?.coins ?? [])]
    .filter((c) => !q || c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .sort((a, b) => b.createdHeight - a.createdHeight);

  return (
    <div className="space-y-10">
      <FrozenNotice state={state} />
      <section className="relative overflow-hidden rounded-3xl border border-white/10 px-6 py-14 sm:px-12 sm:py-20 card">
        {/* the profile under its crown, looking at the words; black dissolves into the card */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-[70%] sm:w-[55%] bg-[url('/art/statue-profile.webp')] bg-cover bg-[30%_0%] sm:bg-[center_top] opacity-60 sm:opacity-75 mix-blend-screen"
          style={{ maskImage: "linear-gradient(to left, rgba(0,0,0,0.9), transparent 90%)", WebkitMaskImage: "linear-gradient(to left, rgba(0,0,0,0.9), transparent 90%)" }}
        />
        <div className="relative max-w-2xl space-y-6">
          <div className="pill fade-up">
            <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_rgba(var(--accent),0.9)]" />
            {LTC_NETWORK === "main" ? "Litecoin mainnet · live" : "Litecoin testnet"}
          </div>
          <h1 className="display fade-up text-4xl sm:text-6xl leading-[1.02] text-white glow-text text-balance">
            Launch your coin <br className="hidden sm:block" />
            on <span className="font-light text-zinc-300">Litecoin</span>.
          </h1>
          <p className="fade-up-2 max-w-xl text-base sm:text-lg leading-relaxed text-zinc-400">
            Litecoin has no smart contracts, so a coin here begins as an OP_RETURN: one desk address, plain Litecoin
            transactions you sign yourself, a bonding curve that graduates into a locked pool with no price ceiling,
            and a ledger anyone can recompute from the chain.
          </p>
          <p className="fade-up-2 max-w-xl text-sm leading-relaxed text-zinc-300">
            When LitVM mainnet goes live, every coin here <span className="text-white">migrates to LitVM automatically</span>:
            same holders, same price, its pool on a DEX.
          </p>
          <div className="fade-up-3 flex flex-wrap items-center gap-3 pt-1">
            <Link href="/litecoin/create" className="btn-primary px-6 py-3 text-sm">
              Deploy a coin
            </Link>
            <Link href="/litecoin/fund" className="btn-ghost px-5 py-3 text-sm">
              Get LTC from ETH or BNB
            </Link>
          </div>
        </div>
      </section>

      {state?.demo && (
        <p className="rounded-xl border border-dashed border-white/15 p-3 text-center text-xs text-zinc-400">
          Demo data — synthetic transactions run through the real rules, not the chain.
        </p>
      )}
      {state && !state.desk.address && (
        <p className="rounded-xl border border-dashed border-white/15 p-3 text-center text-xs text-zinc-400">
          The desk is not live yet: the indexer has not published a desk address. Nothing can be deployed or bought until it does.
        </p>
      )}

      {!!state?.pending?.length && (
        <section className="rounded-xl border border-dashed border-white/15 p-4">
          <h2 className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-2">
            Waiting for a block <span className="text-zinc-600">({state.pending.length})</span>
          </h2>
          <div className="space-y-1">
            {state.pending.slice(0, 10).map((p) => (
              <a key={p.txid} href={txLink(p.txid)} target="_blank" rel="noreferrer" className="flex justify-between gap-3 font-mono text-xs hover:text-white">
                <span className="text-zinc-300 truncate">{p.memo ?? "(no memo)"}</span>
                <span className="text-zinc-500 shrink-0">{p.sender ? shortAddr(p.sender) : "?"} · {fmtLtc(p.valueLit)} LTC</span>
              </a>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-zinc-600">Seen on the network, not yet in the ledger{LTC_NETWORK === "test" ? ": a Litecoin testnet block can take a while" : ""}. Folded in after {state.confirmations} confirmations (~{state.confirmations * 2.5} min).</p>
        </section>
      )}

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3 fade-up-3">
        <Stat label="Ledger height" value={state?.height ? state.height.toLocaleString("en-US") : "—"} />
        <Stat label="Coins" value={String(state?.coins.length ?? 0)} />
        <Stat label="Transactions read" value={String(state?.txsRead ?? 0)} />
        <Stat
          label="State root"
          value={state?.stateRoot ? `${state.stateRoot.slice(0, 10)}…` : "—"}
          href="/litecoin/ledger"
        />
      </section>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
          <h2 className="display text-3xl text-white">
            Coins <span className="text-zinc-600">({coins.length})</span>
          </h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name / ticker"
            className="input rounded-full px-4 py-2 text-sm w-full sm:w-64"
          />
        </div>
        {!isLoading && !state && (
          <p className="text-zinc-500">The ledger snapshot is not published yet — the indexer has not run.</p>
        )}
        {state && coins.length === 0 && (
          <p className="text-zinc-500">{q ? "No coins match your search." : "No coins yet. Be the first to deploy."}</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {coins.map((c) => (
            <CoinCard key={c.ticker} coin={c} state={state} usd={usd} />
          ))}
        </div>
      </section>

      {/* the bust in the water: where the coins go next */}
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
            Carved on Litecoin.
            <br />
            Carried to LitVM.
          </h2>
          <p className="text-sm sm:text-base leading-relaxed text-zinc-400">
            A coin here is a set of Litecoin transactions anyone can replay. When LitVM mainnet goes live, the ledger is
            snapshotted and every coin is recreated there: same holders, same price, its pool on a DEX.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Link href="/litecoin/ledger" className="btn-ghost px-5 py-2.5 text-sm">
              Read the ledger
            </Link>
            <Link href="/" className="btn-ghost px-5 py-2.5 text-sm">
              Notus on LitVM
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

function CoinCard({ coin: c, state, usd }: { coin: LCoin; state: LState | null | undefined; usd: number | null }) {
  const progress = Number((BigInt(c.sold) * 10_000n) / CURVE_SUPPLY) / 100;
  const vol = coinVolume(c, state);
  return (
    <Link href={`/litecoin/c/${c.ticker}`} className="card card-hover group block p-5">
      <div className="flex items-center gap-4">
        <div className="relative shrink-0">
          <TokenLogo uri={c.logo} symbol={c.ticker} size={52} />
          <span className="pointer-events-none absolute -inset-1 -z-10 rounded-2xl bg-white/10 blur-md opacity-0 transition group-hover:opacity-100" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="truncate text-lg font-semibold text-white">{c.name}</span>
            {c.graduated && <span className="pill shrink-0 border-accent/40 text-accent">Graduated</span>}
            {c.feesToHolders && <span className="pill shrink-0">✦ Rewards</span>}
          </div>
          <div className="font-mono text-xs text-zinc-500">${c.ticker} · by {shortAddr(c.creator)}</div>
        </div>
      </div>
      <div className="mt-5 flex items-end justify-between gap-3">
        <div>
          <div className="label">Market cap</div>
          <div className="mt-0.5 display text-3xl leading-none text-white">{fmtMcap(marketCapLtc(c), usd)}</div>
        </div>
        <div className="text-right">
          <div className="label">{c.graduated ? "In the pool" : "In the curve"}</div>
          <div className="mt-0.5 font-mono text-sm text-zinc-300">{fmtLtc(c.graduated ? c.poolLit : c.realLit)} LTC</div>
        </div>
      </div>
      <div className="mt-4 bar-track">
        <div className="bar-fill" style={{ width: `${c.graduated ? 100 : Math.min(progress, 100)}%` }} />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] tracking-widest uppercase text-zinc-500">
        <span>{c.graduated ? "locked pool · no ceiling" : `curve ${progress.toFixed(1)}%`}</span>
        <span>{c.holders} holders</span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-3">
        {([["1h", vol.h1], ["8h", vol.h8], ["24h", vol.h24]] as const).map(([k, v]) => (
          <div key={k}>
            <div className="label">Vol {k}</div>
            <div className="mt-0.5 font-mono text-xs text-zinc-300">{fmtVolume(v, usd)}</div>
          </div>
        ))}
      </div>
    </Link>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href?: string }) {
  const inner = (
    <>
      <div className="label">{label}</div>
      <div className="mt-1.5 font-mono text-lg text-white">{value}</div>
    </>
  );
  const cls = "card p-4";
  return href ? (
    <Link href={href} className={`${cls} card-hover block`}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}
