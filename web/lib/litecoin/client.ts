"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { spotPrice, type CurveView, type Network } from "./ledger.ts";
import { Esplora, PUBLIC_EXPLORER } from "./esplora.ts";
import { isSecret, newSecret, secretFromWif, walletFromSecret, type BuiltTx, type Utxo, type Wallet } from "./tx.ts";
import { isAddress } from "./address.ts";
import { createExtensionStore, extensionById, type ExtWallet, type ExtensionId } from "./extension.ts";

export const LTC_NETWORK: Network = process.env.NEXT_PUBLIC_LTC_NETWORK === "main" ? "main" : "test";
export const LTC_LABEL = LTC_NETWORK === "main" ? "Litecoin" : "Litecoin Testnet";
export const EXPLORER = PUBLIC_EXPLORER[LTC_NETWORK];
/** The browser reaches the explorer through the site's own proxy (/api/ltc):
 *  no CORS surprises, and one place to point at another explorer or a node. */
export const api = new Esplora(process.env.NEXT_PUBLIC_LTC_API ?? "/api/ltc");
/** The extension wallet (Litescribe or Enkrypt) connected to this site, if any. */
export const extension = createExtensionStore(LTC_NETWORK);

export type LCoin = {
  ticker: string; name: string; logo: string; creator: string; feesToHolders: boolean;
  /** X handle, Telegram handle, website, as the creator set them. */
  links?: { x?: string; tg?: string; web?: string };
  vLit: string; vToken: string; realLit: string; sold: string; volumeLit: string;
  /** LTC traded in the last hour, eight hours and day (lit), by block time; absent from an older desk. */
  volume?: { h1: string; h8: string; h24: string };
  /** Graduated coins trade in their locked pool (real reserves, no ceiling). */
  graduated: boolean; poolLit: string; poolToken: string;
  trades: number; holders: number; createdHeight: number; createdTime: number; txid: string;
};

/** A coin's recent volume in lit: what the desk computed, else summed here
 *  from the trades the snapshot carries (its last 500). */
export function coinVolume(coin: Pick<LCoin, "ticker" | "volume">, state: Pick<LState, "trades"> | null | undefined, now = Math.floor(Date.now() / 1000)): { h1: bigint; h8: bigint; h24: bigint } {
  if (coin.volume) return { h1: BigInt(coin.volume.h1), h8: BigInt(coin.volume.h8), h24: BigInt(coin.volume.h24) };
  const v = { h1: 0n, h8: 0n, h24: 0n };
  for (const t of state?.trades ?? []) {
    if (t.ticker !== coin.ticker) continue;
    const age = now - t.time;
    if (age > 24 * 3600) continue;
    const lit = t.type === "sell" ? BigInt(t.lit) + BigInt(t.fee) : BigInt(t.lit);
    v.h24 += lit;
    if (age <= 8 * 3600) v.h8 += lit;
    if (age <= 3600) v.h1 += lit;
  }
  return v;
}

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
  id: string; kind: "sell" | "claim"; holder: string; to: string; lit: string;
  height: number; txid: string; paidTxid: string | null;
};
/** The ledger takes nothing new once a block past the freeze can be mined:
 *  from the moment the chain tip reaches the freeze height. Before that a
 *  freeze is announced, not in force. */
export function isFrozen(state: Pick<LState, "freezeHeight" | "chainTip" | "height"> | null | undefined): boolean {
  if (!state?.freezeHeight) return false;
  return (state.chainTip ?? state.height) >= state.freezeHeight;
}

export type LState = {
  protocol: string; network: Network; height: number; stateRoot: string | null; txsRead: number;
  /** Set once the ledger is frozen for the migration to LitVM: no more trading here. */
  freezeHeight?: number | null;
  treasuryLit: string; liabilitiesLit: string; coins: LCoin[];
  /** LTC the desk took to LitVM for the frozen curves (`bridge`): owed there now, not here. */
  bridgedLit?: string;
  balances: Record<string, Record<string, string>>; claimable: Record<string, string>;
  /** The public key seen behind each address, and the LitVM address a holder registered (`evm 0x…`). */
  pubkeys?: Record<string, string>; evm?: Record<string, string>;
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

export type ActiveWallet = {
  /** False until the browser has read its storage and looked a remembered extension up. */
  ready: boolean;
  /** Which wallet acts: the site's own browser wallet, or a connected extension. */
  kind: "hot" | "ext" | null;
  /** The browser wallet's key, when it is the one acting. */
  secret: string | null;
  wallet: Wallet | null;
  /** The address every action here is paid from; null until a wallet is here, on this network. */
  address: string | null;
  /** The connected extension, on the wrong network or not, with its name and
   *  whether it can be moved to this site's network at all. */
  ext: (ExtWallet & { name: string; url: string; wrongNetwork: boolean; canSwitch: boolean }) | null;
  /** A browser wallet exists here (shown, or waiting behind the extension). */
  hasBrowserWallet: boolean;
  create: () => void;
  restore: (input: string) => boolean;
  forget: () => void;
  connectExtension: (id: ExtensionId) => Promise<void>;
  disconnectExtension: () => void;
  switchExtensionNetwork: () => Promise<void>;
};

/** The wallet that acts on the Litecoin pages. Either the extension the
 *  person connected (Litescribe or Enkrypt: its keys stay in it, it signs
 *  what the site builds) or the wallet the site keeps in this browser: an ordinary
 *  Litecoin key whose address owns the coins, which nothing can recover if
 *  it is lost. A connected extension comes first, even on another network
 *  (so the page can ask it to switch); the browser wallet waits behind it. */
export function useLtcWallet(): ActiveWallet {
  // the server (and the hydration pass) knows nothing; the client reads storage
  const secret = useSyncExternalStore(subscribe, readSecret, () => null);
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const { ext: connected, resolved } = extension.useWallet();
  // neither ever replaces a wallet that is here: forget it first (two tabs racing
  // "Make a wallet" must not overwrite a funded key)
  const create = useCallback(() => {
    if (readSecret()) return;
    writeSecret(newSecret());
  }, []);
  /** Accepts the 64-hex secret shown on the wallet page, or a WIF (with or
   *  without the `p2wpkh:` prefix the wallet page and Electrum show). */
  const restore = useCallback((input: string) => {
    if (readSecret()) return false;
    const v = input.trim().replace(/^p2wpkh:/i, "").trim();
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
  const ext = useMemo(() => {
    if (!connected) return null;
    const meta = extensionById(connected.extension);
    const wanted = meta?.networkName(LTC_NETWORK) ?? null;
    return {
      ...connected,
      name: meta?.name ?? "the extension",
      url: meta?.url ?? "",
      wrongNetwork: connected.network !== wanted || !isAddress(connected.address, LTC_NETWORK),
      canSwitch: wanted !== null,
    };
  }, [connected]);
  const kind = ext ? "ext" : wallet ? "hot" : null;
  return {
    ready: hydrated && resolved,
    kind,
    secret: kind === "hot" ? secret : null,
    wallet: kind === "hot" ? wallet : null,
    address: ext ? (ext.wrongNetwork ? null : ext.address) : wallet?.address ?? null,
    ext,
    hasBrowserWallet: !!wallet,
    create,
    restore,
    forget: () => writeSecret(null),
    connectExtension: async (id: ExtensionId) => {
      await extension.connect(id);
    },
    disconnectExtension: () => extension.disconnect(),
    switchExtensionNetwork: () => extension.switchNetwork(),
  };
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
/** One memory per wallet: a wallet restored after another was forgotten must not inherit its phantom change. */
const pendingKey = (address: string) => `notus.litecoin.pending.${LTC_NETWORK}.${address}`;
type PendingSpends = { spent: Record<string, number>; made: { txid: string; vout: number; value: string; until: number }[] };

function loadPending(address: string): PendingSpends {
  try {
    const v = JSON.parse(localStorage.getItem(pendingKey(address)) ?? "");
    if (v && typeof v === "object" && v.spent && Array.isArray(v.made)) return v as PendingSpends;
  } catch {}
  return { spent: {}, made: [] };
}

function savePending(address: string, p: PendingSpends) {
  const now = Date.now();
  for (const [k, until] of Object.entries(p.spent)) if (until < now) delete p.spent[k];
  p.made = p.made.filter((m) => m.until >= now);
  try {
    localStorage.setItem(pendingKey(address), JSON.stringify(p));
  } catch {}
}

/** Remember a transaction this wallet just broadcast (or may have: an
 *  explorer that timed out could still have relayed it). */
export function noteSpend(built: Pick<BuiltTx, "txid" | "inputs" | "outputs" | "change">, address: string) {
  const p = loadPending(address);
  const until = Date.now() + PENDING_TTL_MS;
  for (const i of built.inputs) p.spent[`${i.txid}:${i.vout}`] = until;
  if (built.change > 0n) p.made.push({ txid: built.txid, vout: built.outputs.length - 1, value: built.change.toString(), until });
  savePending(address, p);
}

/** Forget what the wallet remembers of its own spends (when the explorer says otherwise). */
export function clearPending(address: string) {
  try {
    localStorage.removeItem(pendingKey(address));
  } catch {}
}

/** The explorer's list of coins, seen through what this wallet knows it did. */
export function withPendingSpends(list: Utxo[], address: string): Utxo[] {
  const p = loadPending(address);
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
    queryFn: async () => withPendingSpends(await api.utxos(address!), address!),
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

/** Traded LTC as the pages show it: in dollars when the price is known, else in LTC; a dash for nothing. */
export function fmtVolume(lit: bigint, usd: number | null | undefined): string {
  if (lit === 0n) return "—";
  return fmtMcap(Number(lit) / 1e8, usd);
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

/** An LTC amount typed by a person, exactly: digits, an optional point and
 *  up to eight decimals. Anything else (exponents, hex, signs) is 0. */
export function parseLtc(v: string): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,8}))?$/.exec(v.trim());
  if (!m) return 0n;
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

/** Server components read the ticker of a URL from ledger.ts (this module is
 *  client-only); the client components keep finding it here. */
export { tickerFromParam } from "./ledger.ts";
