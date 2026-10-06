"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { cookieToInitialState, useChainId, useReadContract, useReadContracts } from "wagmi";
import { launchpadAbi, launchTokenAbi } from "./abi";
import { APP_CHAINS, DEFAULT_CHAIN, LAUNCHPAD_ADDRESS, QUOTE_ASSETS, VISIBLE_CHAINS, config, isHiddenToken } from "./config";

/** Any chain the app is wired for (the pages still special-case Robinhood's assets). */
export type AppChain = (typeof APP_CHAINS)[number];

// The chain this browser last used, from wagmi's own cookie. The server reads
// no request headers (so every page prerenders as static), and wagmi itself
// picks the cookie up only after mount: until then it answers the default
// chain. Read as an external store with an "unknown" server snapshot, the
// cookie's chain is in the first frame the browser paints, with the HTML
// still matching the server's.
const subscribeNever = () => () => {};
function cookieChainId(): number | undefined {
  try {
    return cookieToInitialState(config, document.cookie)?.chainId;
  } catch {
    return undefined; // no cookie, or a malformed one
  }
}

/** The app chain currently selected (the default chain when none is). */
export function useAppChain(): AppChain {
  const wagmiId = useChainId();
  const cookieId = useSyncExternalStore(subscribeNever, cookieChainId, () => undefined);
  // wagmi's word once it says anything but the default; before that, the cookie's
  const chainId = wagmiId !== DEFAULT_CHAIN.id ? wagmiId : (cookieId ?? wagmiId);
  return VISIBLE_CHAINS.find((c) => c.id === chainId) ?? DEFAULT_CHAIN;
}

/** Ticker of the chain's gas coin (ETH on GIWA and Robinhood, zkLTC on LitVM). */
export function useNativeSymbol(): string {
  return useAppChain().nativeCurrency.symbol;
}

/** Block explorer base URL for the current app chain. */
export function useExplorer() {
  return useAppChain().blockExplorers.default.url;
}

/** `value`, but only once it has held still for `ms`: what a per-keystroke RPC
 *  call (a quote) should read, so typing does not fire one call per key. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Launchpad address on the current app chain; undefined if not deployed yet. */
export function useLaunchpadAddress(): `0x${string}` | undefined {
  return LAUNCHPAD_ADDRESS[useAppChain().id];
}

export type CurveInfo = {
  vEth: bigint;
  vToken: bigint;
  realEth: bigint;
  sold: bigint;
  graduated: boolean;
  creator: `0x${string}`;
  quoteAsset: `0x${string}`;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

export type TokenMeta = {
  logoURI: string;
  website: string;
  twitter: string;
  telegram: string;
  livestream: string;
  description: string;
};

export type TokenInfo = {
  address: `0x${string}`;
  name: string;
  symbol: string;
  curve: CurveInfo;
  meta: TokenMeta;
  feesToHolders: boolean;
  /** Notus pre-market: a pair asset, never listed as a token to buy. Read
   *  on-chain (only createPreMarket makes transferable tokens), so hiding
   *  them never depends on the web config being up to date. */
  isPreMarket: boolean;
};

// The browser keeps these reads between visits (see app/providers.tsx), so
// polled data stays in the cache for a day rather than the default five
// minutes: a list opened after an hour elsewhere still shows at once.
const DAY = 24 * 60 * 60 * 1000;
const REFETCH = { refetchInterval: 5_000, gcTime: DAY } as const;
// name/symbol never change — fetch once per session, keep forever.
export const IMMUTABLE = { staleTime: Infinity, gcTime: Infinity } as const;
// metadata (logo, links, livestream) changes rarely — poll gently.
export const META_REFETCH = { refetchInterval: 30_000, staleTime: 25_000, gcTime: DAY } as const;
// a warm pass (another chain's list, read ahead) reads once and never polls
const ONCE = { refetchInterval: false, gcTime: DAY } as const;

export function parseCurve(result: unknown): CurveInfo {
  const [vEth, vToken, realEth, sold, graduated, creator, quoteAsset] = result as readonly [
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
    `0x${string}`,
    `0x${string}`,
  ];
  return { vEth, vToken, realEth, sold, graduated, creator, quoteAsset };
}

/** Display info for a curve's quote asset, resolved from the registry. */
export function quoteInfo(
  chainId: number,
  quoteAsset: `0x${string}`
): {
  symbol: string;
  decimals: number;
  address: `0x${string}` | null;
  preIpo: boolean;
  synthetic: boolean;
} {
  // the chain's own coin: ETH on Base and GIWA, zkLTC on LitVM
  if (quoteAsset === ZERO_ADDRESS) {
    const native = APP_CHAINS.find((c) => c.id === chainId)?.nativeCurrency;
    return { symbol: native?.symbol ?? "ETH", decimals: native?.decimals ?? 18, address: null, preIpo: false, synthetic: false };
  }
  const found = (QUOTE_ASSETS[chainId] ?? []).find(
    (q) => q.address?.toLowerCase() === quoteAsset.toLowerCase()
  );
  return found
    ? {
        symbol: found.symbol,
        decimals: found.decimals,
        address: found.address,
        preIpo: found.kind === "preipo" || found.kind === "premarket",
        synthetic: found.kind === "premarket",
      }
    : { symbol: "?", decimals: 18, address: quoteAsset, preIpo: false, synthetic: false };
}

/** True if `address` is itself a registered quote asset on this chain
 *  (a Notus pre-market or a whitelisted stock) — used to keep pair assets
 *  out of the regular Explore grid. */
export function isQuoteAsset(chainId: number, address: `0x${string}`): boolean {
  return (QUOTE_ASSETS[chainId] ?? []).some(
    (q) => q.address?.toLowerCase() === address.toLowerCase()
  );
}

export function parseMeta(result: unknown): TokenMeta {
  const [logoURI, website, twitter, telegram, livestream, description] = result as readonly [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return { logoURI, website, twitter, telegram, livestream, description };
}

/** Full token list with name, symbol, curve state and metadata (multicall). */
// The first slots of the pad's token list are read in the same round trip as
// its count: a slot past the end reverts and reads as a failure, so the list
// is known without waiting for the count. A pad with more coins than this
// reads the rest once the count is in.
const FIRST_SLOTS = 32;

type Read = { status: string; result?: unknown };

/** The previous answer stands in while a list grows, but never across chains:
 *  a name read from one chain's list must not show against another's
 *  addresses. (wagmi puts the chain id in every read's key.) */
function sameChainPlaceholder(chainId: number) {
  return <T>(prev: T | undefined, prevQuery: { queryKey: readonly unknown[] } | undefined): T | undefined => {
    const key = prevQuery?.queryKey?.[1] as { chainId?: number } | undefined;
    return key?.chainId === chainId ? prev : undefined;
  };
}

/** The pad's coins with name, curve and metadata, for the current chain, or
 *  for `chainId`. `warm` reads another chain's list once, without polling,
 *  only so that a switch there finds it in the cache. Two round trips: count
 *  and first slots together, then names, curves and metadata together. */
export function useTokens(chainIdOverride?: number, opts: { warm?: boolean } = {}) {
  const appChainId = useAppChain().id;
  const chainId = chainIdOverride ?? appChainId;
  const pad = LAUNCHPAD_ADDRESS[chainId];
  const padSafe = (pad ?? ZERO_ADDRESS) as `0x${string}`;
  const warm = opts.warm === true;
  const poll = warm ? ONCE : REFETCH;
  const pollMeta = warm ? { ...ONCE, staleTime: META_REFETCH.staleTime } : META_REFETCH;

  const { data: count, isError: countError } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "tokenCount",
    chainId,
    query: { ...poll, enabled: !!pad },
  });

  const slot = (i: number) => ({
    address: padSafe,
    abi: launchpadAbi,
    functionName: "allTokens" as const,
    args: [BigInt(i)] as const,
    chainId,
  });
  // The token list is append-only: a slot never changes once read.
  const first = useReadContracts({
    contracts: Array.from({ length: FIRST_SLOTS }, (_, i) => slot(i)),
    query: { enabled: !!pad, ...IMMUTABLE },
  });
  const firstReads = first.data as readonly Read[] | undefined;
  // the slots that answered are the coins that existed when they were read
  const known = firstReads ? firstReads.filter((r) => r.status === "success").length : 0;
  const n = pad ? Number(count ?? 0n) : 0;
  const restIdx = useMemo(
    () => (firstReads && n > known ? Array.from({ length: n - known }, (_, i) => known + i) : []),
    [firstReads, n, known]
  );
  const rest = useReadContracts({
    contracts: restIdx.map(slot),
    query: { enabled: restIdx.length > 0, ...IMMUTABLE },
  });
  const restReads = rest.data as readonly Read[] | undefined;

  const tokenAddrs = useMemo(() => {
    const seen = new Set<string>();
    const out: `0x${string}`[] = [];
    for (const r of [...(firstReads ?? []), ...(restReads ?? [])]) {
      if (r.status !== "success") continue;
      const a = r.result as `0x${string}`;
      if (seen.has(a.toLowerCase()) || isHiddenToken(chainId, a)) continue;
      seen.add(a.toLowerCase());
      out.push(a);
    }
    return out;
  }, [firstReads, restReads, chainId]);

  // Three tiers so the recurring RPC load stays light: name/symbol once per
  // session, metadata every 30s, only curve state at full 5s cadence.
  const { data: statics, isLoading: staticsLoading } = useReadContracts({
    contracts: tokenAddrs.flatMap((t) => [
      { address: t, abi: launchTokenAbi, functionName: "name" as const, chainId },
      { address: t, abi: launchTokenAbi, functionName: "symbol" as const, chainId },
      { address: padSafe, abi: launchpadAbi, functionName: "feesToHolders" as const, args: [t] as const, chainId },
      // reverts on tokens from launchpads older than v7.3 — treated as false
      { address: t, abi: launchTokenAbi, functionName: "transferable" as const, chainId },
    ]),
    query: { enabled: tokenAddrs.length > 0, ...IMMUTABLE, placeholderData: sameChainPlaceholder(chainId) },
  });

  const { data: metas } = useReadContracts({
    contracts: tokenAddrs.map((t) => ({
      address: padSafe,
      abi: launchpadAbi,
      functionName: "tokenMetadata" as const,
      args: [t] as const,
      chainId,
    })),
    query: { enabled: tokenAddrs.length > 0, ...pollMeta, placeholderData: sameChainPlaceholder(chainId) },
  });

  const { data: curves, isLoading: curvesLoading } = useReadContracts({
    contracts: tokenAddrs.map((t) => ({
      address: padSafe,
      abi: launchpadAbi,
      functionName: "curves" as const,
      args: [t] as const,
      chainId,
    })),
    query: { enabled: tokenAddrs.length > 0, ...poll, placeholderData: sameChainPlaceholder(chainId) },
  });

  const tokens: TokenInfo[] = useMemo(() => {
    if (!statics || !curves) return [];
    // a previous answer may be shorter than the list it stands in for (a coin
    // just created): the coins it covers show now, the new one once read
    const covered = Math.min(tokenAddrs.length, Math.floor(statics.length / 4), curves.length);
    return tokenAddrs
      .slice(0, covered)
      .map((address, i) => {
        const name = statics[i * 4];
        const symbol = statics[i * 4 + 1];
        const feesToHolders = statics[i * 4 + 2];
        const transferable = statics[i * 4 + 3];
        const curve = curves[i];
        const meta = metas?.[i];
        if (
          name?.status !== "success" ||
          symbol?.status !== "success" ||
          curve?.status !== "success"
        )
          return null;
        return {
          address,
          name: name.result as string,
          symbol: symbol.result as string,
          curve: parseCurve(curve.result),
          meta:
            meta?.status === "success"
              ? parseMeta(meta.result)
              : { logoURI: "", website: "", twitter: "", telegram: "", livestream: "", description: "" },
          feesToHolders: feesToHolders?.status === "success" ? (feesToHolders.result as boolean) : false,
          isPreMarket: transferable?.status === "success" ? (transferable.result as boolean) : false,
        };
      })
      .filter((t): t is TokenInfo => t !== null)
      .reverse(); // newest first
  }, [statics, curves, metas, tokenAddrs]);

  // loading until the first slots answer, then until the coins' names and curves are in;
  // an error is a list that could not be read at all, with nothing cached to show
  const isLoading = (!!pad && first.isPending) || (tokenAddrs.length > 0 && (staticsLoading || curvesLoading));
  const isError = !firstReads && (first.isError || (countError && count === undefined));
  return { tokens, isLoading, isError, count: tokenAddrs.length };
}

export function spotPrice(curve: CurveInfo): bigint {
  return (curve.vEth * 10n ** 18n) / curve.vToken;
}

/** Spot price in quote units per whole token, exact to the float. */
export function priceOf(curve: CurveInfo, quoteDecimals: number): number {
  return Number(curve.vEth) / 10 ** quoteDecimals / (Number(curve.vToken) / 1e18);
}

/** Fully diluted market cap in quote units: the spot price times the 1B supply. */
export function marketCapOf(curve: CurveInfo, quoteDecimals: number): number {
  return priceOf(curve, quoteDecimals) * 1_000_000_000;
}

/** What a balance is worth at the spot price, in quote wei, exactly. */
export function valueOf(curve: CurveInfo, balance: bigint): bigint {
  return (balance * curve.vEth) / curve.vToken;
}

/** Curve progress 0..100 (800M = graduation). */
export function curveProgress(curve: CurveInfo): number {
  const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
  return Number((curve.sold * 10_000n) / CURVE_SUPPLY) / 100;
}
