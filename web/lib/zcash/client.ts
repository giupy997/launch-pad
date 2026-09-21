"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { holderOf, newHolderKey, type Network } from "./ledger";

export const ZCASH_NETWORK: Network = "test";
export const ZCASH_LABEL = "Zcash Testnet";
/** Smallest sensible shielded payment: carries signed memos (sell, send, claim). */
export const DUST_ZAT = 1_000n;

export type ZCoin = {
  ticker: string; name: string; logo: string; creator: string; feesToHolders: boolean;
  vZat: string; vToken: string; realZat: string; sold: string; volumeZat: string;
  trades: number; holders: number; createdHeight: number; createdTime: number; txid: string;
};
export type ZTrade = {
  ticker: string; type: "buy" | "sell"; holder: string; zat: string; tokens: string;
  fee: string; height: number; time: number; txid: string;
};
export type ZPayout = {
  id: number; kind: "sell" | "claim"; holder: string; to: string; zat: string;
  height: number; txid: string; paidTxid: string | null;
};
export type ZState = {
  protocol: string; network: Network; height: number; stateRoot: string | null; memosRead: number;
  treasuryZat: string; liabilitiesZat: string; coins: ZCoin[];
  balances: Record<string, Record<string, string>>; claimable: Record<string, string>;
  nonces: Record<string, string>; payouts: ZPayout[]; trades: ZTrade[];
  rejected: { txid: string; height: number; reason: string; memo: string }[];
  roots: { height: number; root: string }[];
  desk: { address: string | null; ufvk: string | null; birthday?: number };
  chainTip: number | null; confirmations: number; updatedAt: number;
};

/** The ledger snapshot the indexer publishes. */
export function useZcashState() {
  return useQuery({
    queryKey: ["zcash-state"],
    queryFn: async (): Promise<ZState | null> => {
      const r = await fetch("/zcash/state.json", { cache: "no-store" });
      return r.ok ? ((await r.json()) as ZState) : null;
    },
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
}

const KEY_STORAGE = "notus.zcash.holder";

/** The holder key lives only in this browser: it owns the balances, and
 *  nothing can recover it if it is lost. */
export function useHolderKey() {
  const [secret, setSecret] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    try {
      setSecret(localStorage.getItem(KEY_STORAGE));
    } catch {}
    setReady(true);
  }, []);
  const save = useCallback((s: string | null) => {
    try {
      if (s) localStorage.setItem(KEY_STORAGE, s);
      else localStorage.removeItem(KEY_STORAGE);
    } catch {}
    setSecret(s);
  }, []);
  const create = useCallback(() => save(newHolderKey().secret), [save]);
  const restore = useCallback(
    (s: string) => {
      const v = s.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(v)) return false;
      save(v);
      return true;
    },
    [save]
  );
  let holder: string | null = null;
  try {
    holder = secret ? holderOf(secret) : null;
  } catch {}
  return { ready, secret, holder, create, restore, forget: () => save(null) };
}

export function fmtZec(zat: bigint | string, digits = 5): string {
  const n = Number(zat) / 1e8;
  if (n === 0) return "0";
  if (n < 10 ** -digits) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtCoins(units: bigint | string): string {
  const n = Number(units) / 1e8;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "k";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function fmtPrice(zecPerCoin: number): string {
  if (zecPerCoin === 0) return "0";
  if (zecPerCoin >= 0.0001) return zecPerCoin.toFixed(6);
  // DexScreener style: 0.0₈286 = eight zeros after the point
  const s = zecPerCoin.toFixed(20);
  const zeros = /^0\.(0+)/.exec(s)?.[1].length ?? 0;
  const sub = String(zeros).replace(/[0-9]/g, (d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)]);
  return `0.0${sub}${s.slice(2 + zeros, 2 + zeros + 3)}`;
}

export const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

export function parseZec(v: string): bigint {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e8)) : 0n;
}

/** ZIP-321 payment request: address, amount and the memo, ready for a wallet. */
export function paymentUri(address: string, zat: bigint, memoText: string): string {
  const bytes = new TextEncoder().encode(memoText);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const memo = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const amount = (Number(zat) / 1e8).toFixed(8).replace(/\.?0+$/, "");
  return `zcash:${address}?amount=${amount}&memo=${memo}`;
}
