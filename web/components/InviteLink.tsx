"use client";

import { useEffect, useState } from "react";
import { shortAddr } from "@/lib/format";
import { fmtPoints } from "@/lib/points/client";

/** A wallet's invite link (its own address as the code), with a copy button
 *  and the invitees it brought. */
export function InviteLink({
  address,
  inviterPct,
  inviteePct,
  inviteeDays,
  invitees,
  compact = false,
}: {
  address: string;
  inviterPct: number;
  inviteePct: number;
  inviteeDays: number;
  invitees: { wallet: string; points: number }[];
  compact?: boolean;
}) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const link = `${origin}/?ref=${address}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      /* the field is selectable */
    }
  }

  return (
    <div className="space-y-2">
      <div className="label">Your invite link</div>
      <div className="flex gap-2">
        <input readOnly value={origin ? link : "…"} onFocus={(e) => e.currentTarget.select()} className="input flex-1 px-3 py-2 font-mono text-xs" />
        <button type="button" onClick={copy} className="btn-ghost px-3 py-2 text-xs">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {!compact && (
        <p className="text-xs text-zinc-500">
          Whoever joins through it signs once to accept: you get {inviterPct}% of their trade points for the season, they get +{inviteePct}% on
          their own for {inviteeDays} days.
        </p>
      )}
      {invitees.length > 0 && (
        <p className="text-xs text-zinc-500">
          {invitees.length} invited:{" "}
          {invitees
            .slice(0, 5)
            .map((i) => `${shortAddr(i.wallet)} (${fmtPoints(i.points)} pts to you)`)
            .join(", ")}
          {invitees.length > 5 && ` and ${invitees.length - 5} more`}
        </p>
      )}
    </div>
  );
}
