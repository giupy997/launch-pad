"use client";

import Link from "next/link";
import { fmtPoints, usePointsChain, useSeason, useWalletPoints } from "@/lib/points/client";
import { InviteLink } from "@/components/InviteLink";

/** The profile's points section: rank, points by kind, the invite link.
 *  Renders nothing on a chain without a season (Base). */
export function PointsCard({ address }: { address: `0x${string}` }) {
  const pc = usePointsChain();
  const season = useSeason(pc?.key ?? null);
  const mine = useWalletPoints(pc?.key ?? null, address);
  if (!pc) return null;
  const s = season.data;
  return (
    <section>
      <h2 className="font-mono text-sm font-semibold tracking-[0.2em] uppercase mb-4 text-zinc-400">
        Points{" "}
        {s?.season && (
          <span className="text-zinc-600">
            · {s.season.name}
            {s.season.rehearsal ? " · rehearsal" : ""}
          </span>
        )}
      </h2>
      <div className="card p-5 grid gap-5 sm:grid-cols-[auto_1fr]">
        <div className="flex gap-6">
          <div>
            <div className="label">Rank</div>
            <div className="display text-3xl text-white">{mine.data?.rank ? `#${mine.data.rank}` : "—"}</div>
          </div>
          <div>
            <div className="label">Points</div>
            <div className="display text-3xl text-white">{mine.data ? fmtPoints(mine.data.points) : "…"}</div>
          </div>
        </div>
        <div className="space-y-3 text-sm">
          {mine.data && mine.data.byKind.length > 0 && (
            <div className="space-y-1">
              {mine.data.byKind.map((k) => (
                <div key={k.kind} className="flex justify-between gap-4 text-zinc-400">
                  <span>{k.label}</span>
                  <span className="font-mono text-zinc-200">{fmtPoints(k.points)}</span>
                </div>
              ))}
            </div>
          )}
          {mine.data && mine.data.byKind.length === 0 && (
            <p className="text-zinc-500">
              Nothing yet: every {pc.quoteSymbol} you trade here earns {s?.rules.pointsPerQuote ?? 20} points.
            </p>
          )}
          {mine.error && <p className="text-zinc-500">{mine.error.message}</p>}
          {s && (
            <InviteLink
              address={address}
              inviterPct={s.rules.inviterPct}
              inviteePct={s.rules.inviteePct}
              inviteeDays={s.rules.inviteeDays}
              invitees={mine.data?.invitees ?? []}
              compact
            />
          )}
          <Link href="/points" className="inline-block text-xs text-zinc-400 underline hover:text-white">
            The board and how points work
          </Link>
        </div>
      </div>
    </section>
  );
}
