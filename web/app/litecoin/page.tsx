"use client";

import Link from "next/link";
import { useState } from "react";
import { CURVE_SUPPLY, spotPrice } from "@/lib/litecoin/ledger";
import { fmtLtc, fmtPrice, shortAddr, useLitecoinState, type LCoin } from "@/lib/litecoin/client";
import { TokenLogo } from "@/components/TokenLogo";

export default function LitecoinExplore() {
  const { data: state, isLoading } = useLitecoinState();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const coins = [...(state?.coins ?? [])]
    .filter((c) => !q || c.ticker.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .sort((a, b) => b.createdHeight - a.createdHeight);

  return (
    <div className="space-y-10">
      <section className="text-center space-y-4 py-6">
        <h1 className="font-mono text-3xl sm:text-4xl font-bold tracking-[0.15em] uppercase leading-snug">
          Launch your coin
          <br />
          on Litecoin
        </h1>
        <p className="text-zinc-400 max-w-xl mx-auto">
          Litecoin has no smart contracts — so a coin here begins as an OP_RETURN. One desk address,
          plain Litecoin transactions signed by you, and a bonding curve anyone can recompute from the chain.
        </p>
        <Link
          href="/litecoin/create"
          className="inline-block rounded-full bg-white px-6 py-2.5 font-semibold text-black hover:bg-zinc-200"
        >
          Deploy a coin
        </Link>
      </section>

      {state?.demo && (
        <p className="rounded-xl border border-dashed border-zinc-700 p-3 text-center text-xs text-zinc-400">
          Demo data — synthetic transactions run through the real rules, not the chain.
        </p>
      )}
      {state && !state.desk.address && (
        <p className="rounded-xl border border-dashed border-zinc-700 p-3 text-center text-xs text-zinc-400">
          The desk is not live yet: the indexer has not published a desk address. Nothing can be deployed or bought until it does.
        </p>
      )}

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
          <h2 className="font-mono text-sm font-semibold tracking-[0.2em] uppercase text-zinc-400">
            Explore <span className="text-zinc-600">({coins.length})</span>
          </h2>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name / ticker"
            className="rounded-full bg-black border border-zinc-700 px-4 py-1.5 text-sm focus:border-white outline-none placeholder:text-zinc-600 w-full sm:w-56"
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
            <CoinCard key={c.ticker} coin={c} />
          ))}
        </div>
      </section>
    </div>
  );
}

function CoinCard({ coin: c }: { coin: LCoin }) {
  const progress = Number((BigInt(c.sold) * 10_000n) / CURVE_SUPPLY) / 100;
  return (
    <Link
      href={`/litecoin/c/${c.ticker}`}
      className="rounded-xl border border-zinc-800 bg-black p-4 hover:border-white transition-colors"
    >
      <div className="flex items-center gap-3">
        <TokenLogo uri={c.logo} symbol={c.ticker} size={44} />
        <div className="min-w-0">
          <div className="font-semibold truncate flex items-center gap-2">
            {c.name}
            {c.feesToHolders && (
              <span className="font-mono text-[9px] tracking-widest uppercase border border-white rounded-full px-1.5 py-px shrink-0">
                ✦ Rewards
              </span>
            )}
          </div>
          <div className="font-mono text-xs text-zinc-400">${c.ticker}</div>
        </div>
      </div>
      <div className="mt-3 text-xs text-zinc-500">creator {shortAddr(c.creator)}</div>
      <div className="mt-3 flex justify-between text-sm">
        <span className="text-zinc-300">{fmtPrice(spotPrice(c))} LTC</span>
        <span className="text-zinc-500">raised {fmtLtc(c.realLit)} LTC</span>
      </div>
      <div className="mt-3 h-1 rounded bg-zinc-800 overflow-hidden">
        <div className="h-full bg-white" style={{ width: `${Math.min(progress, 100)}%` }} />
      </div>
      <div className="mt-1.5 font-mono text-[10px] tracking-widest uppercase text-zinc-500">
        curve {progress.toFixed(1)}% · {c.holders} holders
      </div>
    </Link>
  );
}

function Stat({ label, value, href }: { label: string; value: string; href?: string }) {
  const body = (
    <>
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-sm font-mono">{value}</div>
    </>
  );
  const cls = "rounded-lg border border-zinc-800 bg-black p-3 block";
  return href ? (
    <Link href={href} className={`${cls} hover:border-white`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
