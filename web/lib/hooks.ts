"use client";

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useChainId, useReadContract, useReadContracts } from "wagmi";
import { launchpadAbi, launchTokenAbi } from "./abi";
import { APP_CHAINS, DEFAULT_CHAIN, LAUNCHPAD_ADDRESS, QUOTE_ASSETS, VISIBLE_CHAINS, isHiddenToken } from "./config";

/** Any chain the app is wired for (the pages still special-case Robinhood's assets). */
export type AppChain = (typeof APP_CHAINS)[number];

/** The app chain currently selected (falls back to GIWA Sepolia). */
export function useAppChain(): AppChain {
  const chainId = useChainId();
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

const REFETCH = { refetchInterval: 5_000 } as const;
// name/symbol never change — fetch once per session, keep forever.
export const IMMUTABLE = { staleTime: Infinity, gcTime: Infinity } as const;
// metadata (logo, links, livestream) changes rarely — poll gently.
export const META_REFETCH = { refetchInterval: 30_000, staleTime: 25_000 } as const;

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
export function useTokens() {
  const pad = useLaunchpadAddress();

  const { data: count, isPending: countPending, isError: countError } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "tokenCount",
    query: { ...REFETCH, enabled: !!pad },
  });

  const n = pad ? Number(count ?? 0n) : 0;
  const padSafe = (pad ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;

  // The token list is append-only: entries never change once read.
  const { data: addrs } = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address: padSafe,
      abi: launchpadAbi,
      functionName: "allTokens" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: n > 0, ...IMMUTABLE, placeholderData: keepPreviousData },
  });

  const chainId = useAppChain().id;
  const tokenAddrs = useMemo(
    () =>
      (addrs ?? [])
        .map((r) => (r.status === "success" ? (r.result as `0x${string}`) : null))
        .filter((a): a is `0x${string}` => a !== null && !isHiddenToken(chainId, a)),
    [addrs, chainId]
  );

  // Three tiers so the recurring RPC load stays light: name/symbol once per
  // session, metadata every 30s, only curve state at full 5s cadence.
  const { data: statics, isLoading: staticsLoading } = useReadContracts({
    contracts: tokenAddrs.flatMap((t) => [
      { address: t, abi: launchTokenAbi, functionName: "name" as const },
      { address: t, abi: launchTokenAbi, functionName: "symbol" as const },
      { address: padSafe, abi: launchpadAbi, functionName: "feesToHolders" as const, args: [t] as const },
      // reverts on tokens from launchpads older than v7.3 — treated as false
      { address: t, abi: launchTokenAbi, functionName: "transferable" as const },
    ]),
    query: { enabled: tokenAddrs.length > 0, ...IMMUTABLE, placeholderData: keepPreviousData },
  });

  const { data: metas } = useReadContracts({
    contracts: tokenAddrs.map((t) => ({
      address: padSafe,
      abi: launchpadAbi,
      functionName: "tokenMetadata" as const,
      args: [t] as const,
    })),
    query: { enabled: tokenAddrs.length > 0, ...META_REFETCH, placeholderData: keepPreviousData },
  });

  const { data: curves, isLoading: curvesLoading } = useReadContracts({
    contracts: tokenAddrs.map((t) => ({
      address: padSafe,
      abi: launchpadAbi,
      functionName: "curves" as const,
      args: [t] as const,
    })),
    query: { enabled: tokenAddrs.length > 0, ...REFETCH, placeholderData: keepPreviousData },
  });

  const tokens: TokenInfo[] = useMemo(() => {
    if (!statics || !curves) return [];
    return tokenAddrs
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

  // until the count is in, the list is loading, not empty; a count that failed with nothing cached is an error
  const isLoading = (!!pad && countPending) || ((staticsLoading || curvesLoading) && n > 0);
  return { tokens, isLoading, isError: countError && count === undefined, count: n };
}


/** Spot price in quote wei per whole token (1e18) — an integer, so for a
 *  quote with few decimals (cbLTC: 8) it is a handful of units and loses
 *  its fraction; read prices with priceOf and values with valueOf instead. */
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
