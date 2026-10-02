"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useAppChain, useExplorer } from "@/lib/hooks";
import { fmtUnits } from "@/lib/format";
import { mysticName } from "@/lib/names";
import { ago, fmtPoints, PointsApiError, useLeaderboard, usePointsChain, useSeason, useWalletPoints } from "@/lib/points/client";
import type { SeasonView } from "@/lib/points/types";
import { InviteLink } from "@/components/InviteLink";

export function PointsPage() {
  const pc = usePointsChain();
  const chain = useAppChain();
  if (!pc) return <ComingWithLitVM chainName={chain.name} />;
  return <Season chainKey={pc.key} quoteDecimals={pc.quoteDecimals} quoteSymbol={pc.quoteSymbol} />;
}

function Season({ chainKey, quoteDecimals, quoteSymbol }: { chainKey: string; quoteDecimals: number; quoteSymbol: string }) {
  const { address } = useAccount();
  const explorer = useExplorer();
  const season = useSeason(chainKey);
  const board = useLeaderboard(chainKey, 100);
  const mine = useWalletPoints(chainKey, address);

  const notConnected = season.error instanceof PointsApiError && season.error.status === 404;
  const s = season.data;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="card relative overflow-hidden p-6 sm:p-8 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="pill">{s?.season?.name ?? "Season"}</span>
          <span className="pill">{s?.name ?? chainKey}</span>
          {s?.season?.rehearsal && <span className="pill border-amber-300/30 text-amber-200">Rehearsal · worth nothing · wiped at mainnet</span>}
        </div>
        <h1 className="display text-4xl sm:text-5xl text-white">Points</h1>
        <p className="max-w-2xl text-base leading-relaxed text-zinc-400">
          {s ? (
            <>
              <span className="text-white">{s.rules.pointsPerQuote} points per {quoteSymbol} traded</span>, buy or sell. Hold a coin
              through its graduation, create one that graduates, be among its first buyers, invite traders: more. Points are a
              record of what you did here, computed from the chain. They are not a token.
            </>
          ) : (
            "A record of what every wallet does on the pad, computed from the chain."
          )}
        </p>
        {s && (
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
            <Stat label="Trades" value={s.indexed.trades.toLocaleString("en-US")} />
            <Stat label="Wallets scored" value={s.indexed.wallets.toLocaleString("en-US")} />
            <Stat label="Graduations" value={s.indexed.graduations.toLocaleString("en-US")} />
            <Stat label="Indexed" value={`block ${Number(s.indexed.last).toLocaleString("en-US")}`} hint={ago(s.updatedAt)} />
          </dl>
        )}
        {season.isPending && <p className="text-sm text-zinc-500">Reading the season…</p>}
        {notConnected && <p className="text-sm text-zinc-500">The points service is not connected to this site yet.</p>}
        {season.error && !notConnected && <p className="text-sm text-zinc-500">{season.error.message}</p>}
      </header>

      {address && (
        <section className="card p-5 sm:p-6 space-y-4">
          <h2 className="label">Your points</h2>
          {mine.data ? (
            <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
              <div className="flex gap-6">
                <div>
                  <div className="label">Rank</div>
                  <div className="display text-3xl text-white">{mine.data.rank ? `#${mine.data.rank}` : "—"}</div>
                </div>
                <div>
                  <div className="label">Points</div>
                  <div className="display text-3xl text-white">{fmtPoints(mine.data.points)}</div>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                {mine.data.byKind.length === 0 && (
                  <p className="text-zinc-500">
                    Nothing yet. Every {quoteSymbol} you trade on a coin here earns {s?.rules.pointsPerQuote ?? 20} points.
                  </p>
                )}
                {mine.data.byKind.map((k) => (
                  <div key={k.kind} className="flex justify-between gap-4 border-b border-white/5 pb-1">
                    <span className="text-zinc-400">{k.label}</span>
                    <span className="font-mono text-zinc-200">{fmtPoints(k.points)}</span>
                  </div>
                ))}
                <div className="flex justify-between gap-4 text-zinc-500">
                  <span>
                    {mine.data.trades} trade{mine.data.trades === 1 ? "" : "s"} · {fmtUnits(BigInt(mine.data.volume), quoteDecimals)} {quoteSymbol}
                  </span>
                  {mine.data.inviter && (
                    <span>
                      invited by{" "}
                      <a href={`${explorer}/address/${mine.data.inviter}`} target="_blank" rel="noreferrer" className="underline" title={mine.data.inviter}>
                        {mysticName(mine.data.inviter)}
                      </a>
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">{mine.error ? mine.error.message : "Reading your points…"}</p>
          )}
          {s && (
            <InviteLink
              address={address}
              inviterPct={s.rules.inviterPct}
              inviteePct={s.rules.inviteePct}
              inviteeDays={s.rules.inviteeDays}
              invitees={mine.data?.invitees ?? []}
            />
          )}
        </section>
      )}

      <section className="card p-5 sm:p-6 space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="label">Leaderboard</h2>
          {board.data?.updatedAt && <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-600">updated {ago(board.data.updatedAt)}</span>}
        </div>
        {board.data && board.data.rows.length === 0 && (
          <p className="text-sm text-zinc-500">Nobody has traded on this pad yet. The first trade opens the board.</p>
        )}
        {board.data && board.data.rows.length > 0 && (
          <div className="overflow-x-auto -mx-5 sm:mx-0">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
                  <th className="px-5 sm:px-2 py-2 text-left font-normal">#</th>
                  <th className="px-2 py-2 text-left font-normal">Wallet</th>
                  <th className="px-2 py-2 text-right font-normal">Points</th>
                  <th className="px-2 py-2 text-right font-normal">Trades</th>
                  <th className="px-2 py-2 text-right font-normal">Volume</th>
                  <th className="px-5 sm:px-2 py-2 text-right font-normal">Invited</th>
                </tr>
              </thead>
              <tbody>
                {board.data.rows.map((r) => {
                  const me = address && r.wallet === address.toLowerCase();
                  return (
                    <tr key={r.wallet} className={`border-t border-white/5 ${me ? "bg-white/[0.04]" : ""}`}>
                      <td className="px-5 sm:px-2 py-2 font-mono text-zinc-500">{r.rank}</td>
                      <td className="px-2 py-2">
                        <a href={`${explorer}/address/${r.wallet}`} target="_blank" rel="noreferrer" className="hover:underline text-zinc-200" title={r.wallet}>
                          {mysticName(r.wallet)}
                        </a>
                        {me && <span className="ml-2 text-[10px] tracking-widest uppercase text-zinc-500">you</span>}
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-white">{fmtPoints(r.points)}</td>
                      <td className="px-2 py-2 text-right font-mono text-zinc-400">{r.trades}</td>
                      <td className="px-2 py-2 text-right font-mono text-zinc-400">
                        {fmtUnits(BigInt(r.volume), quoteDecimals)} {quoteSymbol}
                      </td>
                      <td className="px-5 sm:px-2 py-2 text-right font-mono text-zinc-400">{r.invitees || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {board.isPending && !notConnected && <p className="text-sm text-zinc-500">Reading the board…</p>}
      </section>

      {s && <HowItWorks s={s} quoteSymbol={quoteSymbol} />}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-white/10 px-4 py-3">
      <dt className="label">{label}</dt>
      <dd className="mt-0.5 font-semibold text-white">
        {value}
        {hint && <span className="ml-2 font-mono text-[10px] tracking-widest uppercase text-zinc-500">{hint}</span>}
      </dd>
    </div>
  );
}

function HowItWorks({ s, quoteSymbol }: { s: SeasonView; quoteSymbol: string }) {
  const r = s.rules;
  return (
    <section className="card p-5 sm:p-6 space-y-3">
      <h2 className="label">How points work</h2>
      <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-zinc-300 marker:text-zinc-600">
        <li>
          <span className="text-white">{r.pointsPerQuote} points per {quoteSymbol} traded</span>, buy or sell, on any coin of the pad.
          That is one ten-thousandth of what a trade pays the pad&apos;s treasury, so nobody can take out more than they put in.
        </li>
        <li>
          <span className="text-white">A coin graduates:</span> every wallet still holding it gets +{r.holderBonusPct}% on the points it earned
          on that coin, its creator gets {fmtPoints(r.creatorGraduation)}, and its first {r.earlyBuyers} buyers get {fmtPoints(r.earlyBuyer)} each.
        </li>
        <li>
          <span className="text-white">Invites:</span> whoever invites you gets {r.inviterPct}% of your trade points for the season, and you get
          +{r.inviteePct}% on your own for {r.inviteeDays} days. Accepting is a free signature, once.
        </li>
        <li>
          {s.season?.rehearsal ? (
            <>
              <span className="text-white">This is a rehearsal</span> on the testnet: these points are worth nothing and are wiped when LitVM
              mainnet opens. Season 1 starts there.
            </>
          ) : (
            <>
              <span className="text-white">What a season unlocks</span> is announced when it closes, never before. Points are not a token.
            </>
          )}
        </li>
        <li>
          Everything is computed from the chain&apos;s own events; the rules may be tuned during a season and then the whole season is
          recomputed. The code is public.
        </li>
      </ul>
    </section>
  );
}

function ComingWithLitVM({ chainName }: { chainName: string }) {
  const [switchable, setSwitchable] = useState(false);
  useEffect(() => setSwitchable(true), []);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="card p-6 sm:p-8 space-y-4">
        <div className="pill">Coming with LitVM</div>
        <h1 className="display text-4xl sm:text-5xl text-white">Points</h1>
        <p className="text-base leading-relaxed text-zinc-400">
          Points, referrals, badges and fee-sharing are being built for the pad on LitVM, where the coins are headed, not for{" "}
          {chainName}. Nothing here is live on {chainName}: your trades on it earn nothing yet, and whether they are honoured when
          Season 1 opens on LitVM is an open choice, to be announced.
        </p>
        <p className="text-base leading-relaxed text-zinc-400">
          The whole thing is rehearsed on LitVM&apos;s Liteforge testnet first, with real pages and worthless points.
          {switchable && " Switch the chain to LitVM Liteforge in the menu above to see Season 0 running."}
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          <Link href="/about#roadmap" className="btn-ghost px-4 py-2 text-sm">
            What comes with LitVM
          </Link>
        </div>
      </header>
    </div>
  );
}
