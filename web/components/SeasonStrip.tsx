"use client";

import Link from "next/link";
import { usePointsChain, useSeason } from "@/lib/points/client";

/** One line under the hero on a chain with a season: what is on, and the way to the board. */
export function SeasonStrip() {
  const pc = usePointsChain();
  const season = useSeason(pc?.key ?? null);
  if (!pc || !season.data?.season) return null;
  const s = season.data;
  return (
    <Link
      href="/points"
      className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm hover:border-white/30 transition-colors"
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="pill">{s.season!.name}</span>
        <span className="text-zinc-300">
          {s.rules.pointsPerQuote} points per {pc.quoteSymbol} traded
          {s.season!.rehearsal && <span className="text-zinc-500"> · rehearsal on the testnet, worth nothing</span>}
        </span>
      </span>
      <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-zinc-400">Leaderboard →</span>
    </Link>
  );
}
