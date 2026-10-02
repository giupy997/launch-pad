"use client";

// The browser's side of the points: which chain scores them, the service's
// answers through /api/points, the trade-box hint, and the invite kept in the
// browser until a wallet accepts it.

import { useQuery } from "@tanstack/react-query";
import { useAppChain } from "@/lib/hooks";
import { pointsChainById, type PointsChain } from "./chains.ts";
import { milliToPoints, tradeMilli } from "./rules.ts";
import type { LeaderboardResponse, SeasonView, WalletView } from "./types.ts";

/** the chain scoring points for the one selected, if any (Base scores none) */
export function usePointsChain(): PointsChain | null {
  return pointsChainById(useAppChain().id);
}

export class PointsApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PointsApiError";
    this.status = status;
  }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/points/${path}`, { headers: { accept: "application/json" } });
  const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok) throw new PointsApiError(body?.error ?? `the points service answered ${r.status}`, r.status);
  return body as T;
}

export function useSeason(chainKey: string | null) {
  return useQuery({
    queryKey: ["points-season", chainKey],
    enabled: !!chainKey,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: () => get<SeasonView>(`${chainKey}/season`),
  });
}

export function useLeaderboard(chainKey: string | null, limit = 100) {
  return useQuery({
    queryKey: ["points-leaderboard", chainKey, limit],
    enabled: !!chainKey,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: () => get<LeaderboardResponse>(`${chainKey}/leaderboard?limit=${limit}`),
  });
}

export function useWalletPoints(chainKey: string | null, address: string | undefined) {
  return useQuery({
    queryKey: ["points-wallet", chainKey, address?.toLowerCase()],
    enabled: !!chainKey && !!address,
    refetchInterval: 30_000,
    retry: 1,
    queryFn: () => get<WalletView>(`${chainKey}/wallet/${address}`),
  });
}

/** post an accepted invite; the service's status and body come back as they are */
export async function acceptInvite(
  chainKey: string,
  claim: { invitee: string; inviter: string; signature: string }
): Promise<{ status: number; body: { ok?: boolean; error?: string; inviter?: string } }> {
  const r = await fetch(`/api/points/${chainKey}/referral`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(claim),
  });
  const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; inviter?: string };
  return { status: r.status, body };
}

/** the trade points a quote amount earns, as a number of points */
export function pointsFor(quote: bigint, quoteDecimals: number): number {
  return milliToPoints(tradeMilli(quote, quoteDecimals));
}

export function fmtPoints(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 100) return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** seconds ago, in words */
export function ago(ts: number | null | undefined): string {
  if (!ts) return "…";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ------------------------------------------------------------ the invite
// `?ref=0x…` on any page is kept here until a wallet accepts or declines it.
const INVITE_KEY = "notus.points.invite";
const DECLINED_KEY = "notus.points.invite.declined"; // this session only

export function readPendingInvite(): `0x${string}` | null {
  try {
    const v = localStorage.getItem(INVITE_KEY);
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v.toLowerCase() as `0x${string}`) : null;
  } catch {
    return null;
  }
}
export function savePendingInvite(inviter: string) {
  try {
    if (/^0x[0-9a-fA-F]{40}$/.test(inviter) && !localStorage.getItem(INVITE_KEY)) localStorage.setItem(INVITE_KEY, inviter.toLowerCase());
  } catch {
    /* no storage */
  }
}
export function clearPendingInvite() {
  try {
    localStorage.removeItem(INVITE_KEY);
  } catch {
    /* no storage */
  }
}
export function declinedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
}
export function declineForSession() {
  try {
    sessionStorage.setItem(DECLINED_KEY, "1");
  } catch {
    /* no storage */
  }
}
