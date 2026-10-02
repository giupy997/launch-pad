"use client";

import { useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { mysticName } from "@/lib/names";
import {
  acceptInvite,
  clearPendingInvite,
  declineForSession,
  declinedThisSession,
  readPendingInvite,
  savePendingInvite,
  usePointsChain,
  useSeason,
  useWalletPoints,
} from "@/lib/points/client";
import { referralMessage } from "@/lib/points/referral";

/** Mounted on every page: keeps `?ref=0x…` from the address bar in the
 *  browser, and when a wallet connects on a chain with a season and the
 *  invite is still open, offers to accept it with one signature. */
export function InviteCapture() {
  const pc = usePointsChain();
  const { address } = useAccount();
  const season = useSeason(pc?.key ?? null);
  const mine = useWalletPoints(pc?.key ?? null, address);
  const { signMessageAsync } = useSignMessage();
  const [pending, setPending] = useState<`0x${string}` | null>(null);
  const [hidden, setHidden] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // the link's ref, once, then whatever the browser kept
  useEffect(() => {
    try {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref) savePendingInvite(ref);
    } catch {
      /* no URL to read */
    }
    setPending(readPendingInvite());
    setHidden(declinedThisSession());
  }, []);

  // already bound (here or elsewhere): nothing to offer any more
  useEffect(() => {
    if (mine.data?.inviter) {
      clearPendingInvite();
      setPending(null);
    }
  }, [mine.data?.inviter]);

  if (!pc || !season.data?.season || !address || !pending || hidden) return null;
  if (pending === address.toLowerCase()) return null; // one's own link
  if (mine.isPending || mine.data?.inviter) return null;
  const s = season.data;

  async function accept() {
    if (!pc || !s.season) return;
    setBusy(true);
    setNote(null);
    try {
      const signature = await signMessageAsync({ message: referralMessage(pending!, pc.key, s.season.number) });
      const r = await acceptInvite(pc.key, { invitee: address!, inviter: pending!, signature });
      if (r.status === 201 || r.status === 409) {
        clearPendingInvite();
        setNote(r.status === 201 ? "Invite accepted." : "This wallet already has an inviter.");
        setTimeout(() => setPending(null), 1_800);
        void mine.refetch();
      } else {
        setNote(r.body.error ?? `the service answered ${r.status}`);
      }
    } catch (e) {
      setNote((e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function later() {
    declineForSession();
    setHidden(true);
  }

  return (
    <div className="fixed bottom-20 md:bottom-5 right-4 left-4 sm:left-auto sm:w-96 z-40 card p-4 space-y-3 shadow-2xl">
      <div className="label">Invite · {s.season!.name}</div>
      <p className="text-sm text-zinc-300">
        <span className="font-semibold text-white" title={pending}>{mysticName(pending)}</span> invited you. Accept and you get +{s.rules.inviteePct}% on your trade points for{" "}
        {s.rules.inviteeDays} days; they get {s.rules.inviterPct}% of yours. A free signature, nothing is sent on chain.
      </p>
      {note && <p className="text-xs text-zinc-400">{note}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={accept} disabled={busy} className="flex-1 rounded-full bg-white py-2 text-sm font-semibold text-black disabled:opacity-50">
          {busy ? "Sign in wallet…" : "Accept"}
        </button>
        <button type="button" onClick={later} disabled={busy} className="btn-ghost px-4 py-2 text-sm">
          Not now
        </button>
      </div>
    </div>
  );
}
