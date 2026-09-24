"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Network } from "./ledger.ts";
import { Esplora, PUBLIC_EXPLORER } from "./esplora.ts";
import { isSecret, newSecret, secretFromWif, walletFromSecret, type Wallet } from "./tx.ts";

export const LTC_NETWORK: Network = process.env.NEXT_PUBLIC_LTC_NETWORK === "main" ? "main" : "test";
export const LTC_LABEL = LTC_NETWORK === "main" ? "Litecoin" : "Litecoin Testnet";
export const EXPLORER = PUBLIC_EXPLORER[LTC_NETWORK];
/** The browser reaches the explorer through the site's own proxy (/api/ltc):
 *  no CORS surprises, and one place to point at another explorer or a node. */
export const api = new Esplora(process.env.NEXT_PUBLIC_LTC_API ?? "/api/ltc");

export type LCoin = {
  ticker: string; name: string; logo: string; creator: string; feesToHolders: boolean;
  vLit: string; vToken: string; realLit: string; sold: string; volumeLit: string;
  trades: number; holders: number; createdHeight: number; createdTime: number; txid: string;
};
export type LTrade = {
  ticker: string; type: "buy" | "sell"; holder: string; lit: string; tokens: string;
  fee: string; height: number; time: number; txid: string;
};
export type LPayout = {
  id: number; kind: "sell" | "claim"; holder: string; to: string; lit: string;
  height: number; txid: string; paidTxid: string | null;
};
export type LState = {
  protocol: string; network: Network; height: number; stateRoot: string | null; txsRead: number;
  treasuryLit: string; liabilitiesLit: string; coins: LCoin[];
  balances: Record<string, Record<string, string>>; claimable: Record<string, string>;
  payouts: LPayout[]; trades: LTrade[];
  rejected: { txid: string; height: number; reason: string; memo: string }[];
  roots: { height: number; root: string }[];
  desk: { address: string | null; network: Network };
  chainTip: number | null; confirmations: number; updatedAt: number; demo?: boolean;
};

/** The ledger snapshot: live from the desk through /api/ltc-state when the
 *  site is pointed at one (LTC_STATE_URL), else the file published with it. */
export function useLitecoinState() {
  return useQuery({
    queryKey: ["litecoin-state"],
    queryFn: async (): Promise<LState | null> => {
      for (const url of ["/api/ltc-state", "/litecoin/state.json"]) {
        try {
          const r = await fetch(url, { cache: "no-store" });
          if (r.ok) return (await r.json()) as LState;
        } catch {}
      }
      return null;
    },
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
}

const KEY_STORAGE = "notus.litecoin.key";

// One store for every component: making or restoring a wallet in one place
// (the inline prompt) must show up everywhere at once (header chip, trade box).
const listeners = new Set<() => void>();
let cachedSecret: string | null | undefined; // undefined = not read from storage yet

function readSecret(): string | null {
  if (cachedSecret === undefined) {
    try {
      const v = localStorage.getItem(KEY_STORAGE);
      cachedSecret = v && isSecret(v) ? v : null;
    } catch {
      cachedSecret = null;
    }
  }
  return cachedSecret;
}

function writeSecret(s: string | null) {
  cachedSecret = s;
  try {
    if (s) localStorage.setItem(KEY_STORAGE, s);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {}
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY_STORAGE) {
      cachedSecret = undefined; // another tab changed it
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

/** The wallet lives only in this browser: an ordinary Litecoin key whose
 *  address owns the coins. Nothing can recover it if it is lost. */
export function useLtcWallet() {
  // the server (and the hydration pass) knows nothing; the client reads storage
  const secret = useSyncExternalStore(subscribe, readSecret, () => null);
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const create = useCallback(() => writeSecret(newSecret()), []);
  /** Accepts the 64-hex secret shown on the wallet page, or a WIF. */
  const restore = useCallback((input: string) => {
    const v = input.trim();
    const s = isSecret(v.toLowerCase()) ? v.toLowerCase() : secretFromWif(v, LTC_NETWORK);
    if (!s || !isSecret(s)) return false;
    writeSecret(s);
    return true;
  }, []);
  const wallet: Wallet | null = useMemo(() => {
    try {
      return secret ? walletFromSecret(secret, LTC_NETWORK) : null;
    } catch {
      return null;
    }
  }, [secret]);
  return { ready, secret, wallet, address: wallet?.address ?? null, create, restore, forget: () => writeSecret(null) };
}

/** The wallet's coins, straight from the explorer (unconfirmed included). */
export function useUtxos(address: string | null | undefined) {
  const q = useQuery({
    queryKey: ["ltc-utxos", address],
    queryFn: () => api.utxos(address!),
    enabled: !!address,
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
  let balance = 0n, confirmed = 0n;
  for (const u of q.data ?? []) {
    balance += u.value;
    if (u.confirmed) confirmed += u.value;
  }
  return { ...q, utxos: q.data ?? [], balance, confirmed };
}

export function useFeeRate() {
  return useQuery({ queryKey: ["ltc-fee"], queryFn: () => api.feeRate(), staleTime: 60_000, refetchInterval: 120_000 });
}

export const txLink = (txid: string) => `${EXPLORER}/tx/${txid}`;
export const addressLink = (address: string) => `${EXPLORER}/address/${address}`;

export function fmtLtc(lit: bigint | string, digits = 5): string {
  const n = Number(lit) / 1e8;
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

export function fmtPrice(ltcPerCoin: number): string {
  if (ltcPerCoin === 0) return "0";
  if (ltcPerCoin >= 0.0001) return ltcPerCoin.toFixed(6);
  // DexScreener style: 0.0₈286 = eight zeros after the point
  const s = ltcPerCoin.toFixed(20);
  const zeros = /^0\.(0+)/.exec(s)?.[1].length ?? 0;
  const sub = String(zeros).replace(/[0-9]/g, (d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)]);
  return `0.0${sub}${s.slice(2 + zeros, 2 + zeros + 3)}`;
}

export const shortAddr = (a: string) => `${a.slice(0, 9)}…${a.slice(-5)}`;

export function parseLtc(v: string): bigint {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e8)) : 0n;
}
