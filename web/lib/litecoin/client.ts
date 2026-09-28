"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { spotPrice, type CurveView, type Network } from "./ledger.ts";
import { Esplora, PUBLIC_EXPLORER } from "./esplora.ts";
import { isSecret, newSecret, secretFromWif, walletFromSecret, type BuiltTx, type Utxo, type Wallet } from "./tx.ts";

export const LTC_NETWORK: Network = process.env.NEXT_PUBLIC_LTC_NETWORK === "main" ? "main" : "test";
export const LTC_LABEL = LTC_NETWORK === "main" ? "Litecoin" : "Litecoin Testnet";
export const EXPLORER = PUBLIC_EXPLORER[LTC_NETWORK];
/** The browser reaches the explorer through the site's own proxy (/api/ltc):
 *  no CORS surprises, and one place to point at another explorer or a node. */
export const api = new Esplora(process.env.NEXT_PUBLIC_LTC_API ?? "/api/ltc");

export type LCoin = {
  ticker: string; name: string; logo: string; creator: string; feesToHolders: boolean;
  /** X handle, Telegram handle, website, as the creator set them. */
  links?: { x?: string; tg?: string; web?: string };
  vLit: string; vToken: string; realLit: string; sold: string; volumeLit: string;
  /** Graduated coins trade in their locked pool (real reserves, no ceiling). */
  graduated: boolean; poolLit: string; poolToken: string;
  trades: number; holders: number; createdHeight: number; createdTime: number; txid: string;
};

/** The quote view of a snapshot coin (strings → bigints). */
export function curveOf(c: LCoin): CurveView {
  return {
    vLit: BigInt(c.vLit), vToken: BigInt(c.vToken), realLit: BigInt(c.realLit), sold: BigInt(c.sold),
    graduated: !!c.graduated, poolLit: BigInt(c.poolLit ?? "0"), poolToken: BigInt(c.poolToken ?? "0"),
  };
}
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
  /** Set once the ledger is frozen for the migration to LitVM: no more trading here. */
  freezeHeight?: number | null;
  treasuryLit: string; liabilitiesLit: string; coins: LCoin[];
  balances: Record<string, Record<string, string>>; claimable: Record<string, string>;
  payouts: LPayout[]; trades: LTrade[];
  rejected: { txid: string; height: number; reason: string; memo: string }[];
  roots: { height: number; root: string }[];
  desk: { address: string | null; network: Network };
  /** Instructions seen in the mempool, waiting for a block (not folded in). */
  pending?: { txid: string; sender: string | null; valueLit: string; memo: string | null; seen: number }[];
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

// One wallet per network: the testnet key keeps its original name, a mainnet
// wallet is a different key so test habits never touch real coins.
const KEY_STORAGE = LTC_NETWORK === "test" ? "notus.litecoin.key" : `notus.litecoin.key.${LTC_NETWORK}`;

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
// ------------------------------------------------------ pending spends
// The explorer learns of a transaction a little after we broadcast it (and
// with several explorers in fallback, one may hear of it later than another).
// Until it does, the coins it spent still look unspent and its change does
// not exist yet: a second transaction built from that picture would conflict
// with the first in the mempool. So the browser remembers what it spent and
// what change it made, for a while, and reads its coins through that memory.
const PENDING_TTL_MS = 30 * 60_000;
const PENDING_STORAGE = `notus.litecoin.pending.${LTC_NETWORK}`;
type PendingSpends = { spent: Record<string, number>; made: { txid: string; vout: number; value: string; until: number }[] };

function loadPending(): PendingSpends {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_STORAGE) ?? "");
    if (v && typeof v === "object" && v.spent && Array.isArray(v.made)) return v as PendingSpends;
  } catch {}
  return { spent: {}, made: [] };
}

function savePending(p: PendingSpends) {
  const now = Date.now();
  for (const [k, until] of Object.entries(p.spent)) if (until < now) delete p.spent[k];
  p.made = p.made.filter((m) => m.until >= now);
  try {
    localStorage.setItem(PENDING_STORAGE, JSON.stringify(p));
  } catch {}
}

/** Remember a transaction this wallet just broadcast (or may have: an
 *  explorer that timed out could still have relayed it). */
export function noteSpend(built: Pick<BuiltTx, "txid" | "inputs" | "outputs" | "change">) {
  const p = loadPending();
  const until = Date.now() + PENDING_TTL_MS;
  for (const i of built.inputs) p.spent[`${i.txid}:${i.vout}`] = until;
  if (built.change > 0n) p.made.push({ txid: built.txid, vout: built.outputs.length - 1, value: built.change.toString(), until });
  savePending(p);
}

/** The explorer's list of coins, seen through what this wallet knows it did. */
export function withPendingSpends(list: Utxo[]): Utxo[] {
  const p = loadPending();
  const now = Date.now();
  const listed = new Set(list.map((u) => `${u.txid}:${u.vout}`));
  const made = p.made
    .filter((m) => m.until >= now && !listed.has(`${m.txid}:${m.vout}`))
    .map((m) => ({ txid: m.txid, vout: m.vout, value: BigInt(m.value), confirmed: false }));
  return [...list, ...made].filter((u) => (p.spent[`${u.txid}:${u.vout}`] ?? 0) < now);
}

export function useUtxos(address: string | null | undefined) {
  const q = useQuery({
    queryKey: ["ltc-utxos", address],
    queryFn: async () => withPendingSpends(await api.utxos(address!)),
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

/** Where the migrated coins live on LitVM, published with the site after the
 *  migration as /litecoin/migrated.json (absent until then). */
export type Migrated = { chainId: number; launchpad: string; tokens: Record<string, `0x${string}`> };
export function useMigrated() {
  return useQuery({
    queryKey: ["ltc-migrated"],
    queryFn: async (): Promise<Migrated | null> => {
      try {
        const r = await fetch("/litecoin/migrated.json");
        if (r.ok) return (await r.json()) as Migrated;
      } catch {}
      return null;
    },
    staleTime: 5 * 60_000,
  });
}

/** LTC in fiat, from the site (five-minute cache); null while unknown. */
export function useLtcPrice() {
  return useQuery({
    queryKey: ["ltc-price"],
    queryFn: async (): Promise<{ usd: number | null; eur: number | null }> => {
      try {
        const r = await fetch("/api/ltc-price");
        if (r.ok) return (await r.json()) as { usd: number | null; eur: number | null };
      } catch {}
      return { usd: null, eur: null };
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/** Fully diluted market cap in LTC: the spot price times the 1B supply. */
export function marketCapLtc(c: Parameters<typeof spotPrice>[0]): number {
  return spotPrice(c) * 1_000_000_000;
}

/** "$12.3K" — the way meme-coin caps are read. */
export function fmtUsd(n: number): string {
  if (!(n > 0)) return "$0";
  if (n < 1_000) return `$${n.toFixed(n < 10 ? 2 : 0)}`;
  if (n < 1_000_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${(n / 1_000_000_000).toFixed(2)}B`;
}

/** Market cap as the pages show it: in dollars when the price is known, else in LTC. */
export function fmtMcap(ltc: number, usd: number | null | undefined): string {
  if (usd) return fmtUsd(ltc * usd);
  return `${ltc >= 100 ? ltc.toFixed(0) : ltc.toFixed(2)} LTC`;
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
