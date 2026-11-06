"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQueries } from "@tanstack/react-query";
import { parseAbi, type Abi } from "viem";
import { cookieToInitialState, useChainId, useConfig, useReadContract } from "wagmi";
import { hashFn, readContractsQueryOptions } from "wagmi/query";
import { launchpadAbi, launchTokenAbi, padAbiFor, type PadVersion } from "./abi";
import { APP_CHAINS, DEFAULT_CHAIN, LAUNCHPAD_ADDRESS, PAD_VERSION, QUOTE_ASSETS, VISIBLE_CHAINS, config, isHiddenToken } from "./config";

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

/** The generation of the current chain's pad (PAD_VERSION; 11 for a chain the config does not place). */
export function usePadVersion(): PadVersion {
  return PAD_VERSION[useAppChain().id] ?? 11;
}

/** The pad ABI the current chain is read and written with: reads of what both
 *  generations share work with either, feeConfig and the version-only reads
 *  need this one. */
export function usePadAbi() {
  return padAbiFor(usePadVersion());
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
   *  on-chain (only v11's createPreMarket made transferable tokens), so hiding
   *  them never depends on the web config being up to date. v12 tokens have
   *  no transferable(): the read reverts and reads as false, as on old pads. */
  isPreMarket: boolean;
};

/** The pre-market flag of a v11 token, read on its own because v12's token
 *  ABI no longer carries it (there, and on tokens older than v7.3, the read
 *  fails and the coin is an ordinary one). */
const transferableAbi = parseAbi(["function transferable() view returns (bool)"]);

// The browser keeps these reads between visits (see app/providers.tsx), so
// polled data stays in the cache for a day rather than the default five
// minutes: a list opened after an hour elsewhere still shows at once.
const DAY = 24 * 60 * 60 * 1000;
const REFETCH = { refetchInterval: 5_000, gcTime: DAY } as const;
// a list this long (Liteforge: 358 coins on the rehearsal pad) reads its curves once a
// minute and its metadata every five: at five and thirty seconds that was 84 calls a
// second, for as long as the page stayed open, to a node that answers a request in one
// to ten seconds; at twenty seconds for the curves it was still 30
const BIG_LIST = 100;
const BIG_LIST_REFETCH = 60_000;
const BIG_LIST_META_REFETCH = { refetchInterval: 300_000, staleTime: 240_000, gcTime: DAY } as const;
// name/symbol never change — fetch once per session, keep forever.
export const IMMUTABLE = { staleTime: Infinity, gcTime: Infinity } as const;
// metadata (logo, links, livestream) changes rarely — poll gently.
export const META_REFETCH = { refetchInterval: 30_000, staleTime: 25_000, gcTime: DAY } as const;
// a warm pass (another chain's list, read ahead) reads once and never polls
const ONCE = { refetchInterval: false, gcTime: DAY } as const;
// a read a page waits on is asked again this often until it has answered: one failed RPC
// call must not leave a figure on "…" for the rest of the visit
export const RETRY_MS = 5_000;

/** Whether a multicall entry holds the chain's answer: a result, a revert, or no
 *  contract at the address. A multicall resolves even when the RPC failed; each
 *  entry then holds the transport's error (a timeout, a rate limit, no network,
 *  a node's internal error), which says nothing of the chain and is worth asking
 *  again. The transport is looked for first: viem wraps a node's internal error
 *  (-32603) in a ContractFunctionRevertedError too, with the RPC error below it. */
// (RpcRequestError is not among them: it is the base of every error a node answers with, a
// revert included; the error above it in the chain says which it is)
const TRANSPORT_FAILURES = new Set([
  "HttpRequestError",
  "WebSocketRequestError",
  "SocketClosedError",
  "TimeoutError",
  "InternalRpcError",
  "LimitExceededRpcError",
]);
const CHAIN_ANSWERS = new Set([
  "ContractFunctionRevertedError",
  "ContractFunctionZeroDataError",
  "RawContractError",
  "AbiDecodingZeroDataError",
  "ExecutionRevertedError",
]);
/** An answer of empty data (a contract not there yet, on a node a few blocks behind): read
 *  again, never kept as what the chain says. */
export function zeroDataAnswer(entry: { status?: unknown; error?: unknown } | undefined): boolean {
  if (!entry || entry.status !== "failure") return false;
  let e = entry.error as { name?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 12; depth++, e = e.cause as typeof e) {
    if (e.name === "ContractFunctionZeroDataError" || e.name === "AbiDecodingZeroDataError") return true;
  }
  return false;
}
export function chainAnswered(entry: { status?: unknown; error?: unknown } | undefined): boolean {
  if (!entry) return false;
  if (entry.status !== "failure") return true;
  let answered = false;
  let e = entry.error as { name?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; e && depth < 12; depth++, e = e.cause as typeof e) {
    if (typeof e.name !== "string") continue;
    if (TRANSPORT_FAILURES.has(e.name)) return false;
    if (CHAIN_ANSWERS.has(e.name)) answered = true;
  }
  return answered;
}

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

/** The pad's token list, read in groups. */
// A group is GROUP coins by their place in the pad's own list. The pad only
// ever appends, so a full group never changes, and each group is read by
// itself: its slots, then the names, metadata and curves of its coins. A
// group shows as soon as it has answered, the newest groups asked first, and
// a group whose request failed is asked again without holding the others.
// Before, the names of every coin were one query and their curves another:
// on Liteforge (358 coins, a node that takes seconds a request) nothing
// showed until the slowest of sixty requests had answered, and one that
// failed left the whole list empty.
const GROUP = 30;

type Read = { status: string; result?: unknown };
type GroupRead = { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[]; chainId: number };
type KeyContract = { address?: string; args?: readonly unknown[]; chainId?: number };

/** The previous answer of the same group on the same chain stands in while
 *  the group's list grows (a coin just created), and never another group's
 *  or another chain's: a name must not show against another coin's address.
 *  The group is told by the first read of the query's key. */
function sameGroup(chainId: number, isFirst: (c: KeyContract) => boolean) {
  return <T>(prev: T | undefined, prevQuery: { queryKey: readonly unknown[] } | undefined): T | undefined => {
    const c = (prevQuery?.queryKey?.[1] as { contracts?: KeyContract[] } | undefined)?.contracts?.[0];
    return c && c.chainId === chainId && isFirst(c) ? prev : undefined;
  };
}
const sameAddress = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
/** whether every read of an answer failed: a request that did not get through, to ask again */
const allFailed = (data: unknown) => Array.isArray(data) && data.length > 0 && data.every((r: Read) => r.status !== "success");

/** The pad's coins with name, curve and metadata, for the current chain, or
 *  for `chainId`, newest first. `warm` reads another chain's list once,
 *  without polling, only so that a switch there finds it in the cache.
 *  `isLoading` until the first group is in; `isLoadingMore` while others
 *  are still being read; `complete` once every group has answered. */
export function useTokens(chainIdOverride?: number, opts: { warm?: boolean } = {}) {
  const appChainId = useAppChain().id;
  const chainId = chainIdOverride ?? appChainId;
  const pad = LAUNCHPAD_ADDRESS[chainId];
  const padSafe = (pad ?? ZERO_ADDRESS) as `0x${string}`;
  const warm = opts.warm === true;
  const wagmiConfig = useConfig();

  const { data: count, isError: countError } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "tokenCount",
    chainId,
    query: { ...(warm ? ONCE : REFETCH), enabled: !!pad },
  });
  const n = pad && count !== undefined ? Number(count) : undefined;

  // The first group's slots are read in the same round trip as the count (a slot past
  // the end reverts and reads as a failure); the others once the count says how many.
  // The last group holds what the count says it holds: its key changes when a coin is
  // created, and only that group is read again.
  const groups = !pad ? 0 : n === undefined ? 1 : Math.ceil(n / GROUP);
  const order = useMemo(() => Array.from({ length: groups }, (_, i) => groups - 1 - i), [groups]); // newest first
  const sizeOf = (g: number) => (n === undefined ? GROUP : Math.max(0, Math.min(GROUP, n - g * GROUP)));
  const big = (n ?? 0) > BIG_LIST;

  const slotQs = useQueries({
    queries: order.map((g) => {
      const size = sizeOf(g);
      const contracts: GroupRead[] = Array.from({ length: size }, (_, i) => ({
        address: padSafe,
        abi: launchpadAbi as Abi,
        functionName: "allTokens",
        args: [BigInt(g * GROUP + i)],
        chainId,
      }));
      return {
        ...readContractsQueryOptions(wagmiConfig, { contracts, chainId }),
        queryKeyHashFn: hashFn,
        enabled: !!pad && size > 0,
        ...IMMUTABLE,
        // a slot the count says exists and that did not answer is asked again
        refetchInterval: (q: { state: { data?: unknown } }) =>
          n !== undefined && Array.isArray(q.state.data) && (q.state.data as Read[]).some((r) => r.status !== "success") ? RETRY_MS : false,
        placeholderData: sameGroup(chainId, (c) => c.args?.[0] === BigInt(g * GROUP)),
      };
    }),
  });

  // each group's coins, in the pad's order, the hidden ones left out
  const slotData = slotQs.map((q) => q.data as readonly Read[] | undefined);
  const slotKey = slotData.map((d) => (d ? d.map((r) => (r.status === "success" ? (r.result as string) : "")).join(",") : "?")).join("|");
  const addrsOf = useMemo(
    () =>
      slotData.map((d) =>
        (d ?? []).flatMap((r) => (r.status === "success" && !isHiddenToken(chainId, r.result as `0x${string}`) ? [r.result as `0x${string}`] : []))
      ),
    // the answers' content, not their identity: a refetch that reads the same slots changes nothing
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slotKey, chainId]
  );

  // Three tiers so the recurring RPC load stays light: name/symbol once per
  // session, metadata every 30s, only curve state at the full cadence.
  const staticQs = useQueries({
    queries: order.map((_, i) => {
      const addrs = addrsOf[i];
      const contracts: GroupRead[] = addrs.flatMap((t) => [
        { address: t, abi: launchTokenAbi as Abi, functionName: "name", chainId },
        { address: t, abi: launchTokenAbi as Abi, functionName: "symbol", chainId },
        { address: padSafe, abi: launchpadAbi as Abi, functionName: "feesToHolders", args: [t], chainId },
        // reverts on tokens from launchpads older than v7.3 and on v12's — treated as false
        { address: t, abi: transferableAbi as Abi, functionName: "transferable", chainId },
      ]);
      return {
        ...readContractsQueryOptions(wagmiConfig, { contracts, chainId }),
        queryKeyHashFn: hashFn,
        enabled: addrs.length > 0,
        ...IMMUTABLE,
        refetchInterval: (q: { state: { data?: unknown } }) => (allFailed(q.state.data) ? RETRY_MS : false),
        placeholderData: sameGroup(chainId, (c) => sameAddress(c.address, addrs[0] ?? "")),
      };
    }),
  });
  const metaQs = useQueries({
    queries: order.map((_, i) => {
      const addrs = addrsOf[i];
      const contracts: GroupRead[] = addrs.map((t) => ({ address: padSafe, abi: launchpadAbi as Abi, functionName: "tokenMetadata", args: [t], chainId }));
      return {
        ...readContractsQueryOptions(wagmiConfig, { contracts, chainId }),
        queryKeyHashFn: hashFn,
        enabled: addrs.length > 0,
        ...(warm ? { ...ONCE, staleTime: META_REFETCH.staleTime } : big ? BIG_LIST_META_REFETCH : META_REFETCH),
        placeholderData: sameGroup(chainId, (c) => sameAddress(c.args?.[0], addrs[0] ?? "")),
      };
    }),
  });
  const curveQs = useQueries({
    queries: order.map((_, i) => {
      const addrs = addrsOf[i];
      const contracts: GroupRead[] = addrs.map((t) => ({ address: padSafe, abi: launchpadAbi as Abi, functionName: "curves", args: [t], chainId }));
      return {
        ...readContractsQueryOptions(wagmiConfig, { contracts, chainId }),
        queryKeyHashFn: hashFn,
        enabled: addrs.length > 0,
        ...(warm ? ONCE : REFETCH),
        ...(!warm && big ? { refetchInterval: BIG_LIST_REFETCH } : {}),
        placeholderData: sameGroup(chainId, (c) => sameAddress(c.args?.[0], addrs[0] ?? "")),
      };
    }),
  });

  const staticData = staticQs.map((q) => q.data as readonly Read[] | undefined);
  const metaData = metaQs.map((q) => q.data as readonly Read[] | undefined);
  const curveData = curveQs.map((q) => q.data as readonly Read[] | undefined);
  // one stamp for the answers the list is built from: react-query hands back the same arrays
  // while nothing changed, but useQueries a new outer array on every render
  const stamp = [...staticQs, ...metaQs, ...curveQs].map((q) => q.dataUpdatedAt).join(",");

  const tokens: TokenInfo[] = useMemo(() => {
    const out: TokenInfo[] = [];
    // `order` is newest group first; within a group the pad's order is oldest first
    for (let i = 0; i < order.length; i++) {
      const addrs = addrsOf[i];
      const statics = staticData[i];
      const curves = curveData[i];
      const metas = metaData[i];
      if (!addrs?.length || !statics || !curves) continue;
      // a previous answer may be shorter than the group it stands in for (a coin
      // just created): the coins it covers show now, the new one once read
      const covered = Math.min(addrs.length, Math.floor(statics.length / 4), curves.length);
      const group: TokenInfo[] = [];
      for (let k = 0; k < covered; k++) {
        const name = statics[k * 4];
        const symbol = statics[k * 4 + 1];
        const feesToHolders = statics[k * 4 + 2];
        const transferable = statics[k * 4 + 3];
        const curve = curves[k];
        const meta = metas?.[k];
        if (name?.status !== "success" || symbol?.status !== "success" || curve?.status !== "success") continue;
        group.push({
          address: addrs[k],
          name: name.result as string,
          symbol: symbol.result as string,
          curve: parseCurve(curve.result),
          meta:
            meta?.status === "success"
              ? parseMeta(meta.result)
              : { logoURI: "", website: "", twitter: "", telegram: "", livestream: "", description: "" },
          feesToHolders: feesToHolders?.status === "success" ? (feesToHolders.result as boolean) : false,
          isPreMarket: transferable?.status === "success" ? (transferable.result as boolean) : false,
        });
      }
      out.push(...group.reverse()); // newest first
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrsOf, stamp, order]);

  // what is still being read: the count, a group's slots, or the names and curves of a group
  // whose coins are known
  const pending =
    !!pad &&
    ((count === undefined && !countError) ||
      slotQs.some((q, i) => sizeOf(order[i]) > 0 && q.isPending) ||
      addrsOf.some((a, i) => a.length > 0 && (staticQs[i].isPending || curveQs[i].isPending)));
  const known = addrsOf.reduce((sum, a) => sum + a.length, 0);
  // loading until the first group is on the page; an error is a list that could not be read
  // at all, with nothing to show
  const isLoading = pending && tokens.length === 0;
  const isLoadingMore = pending && tokens.length > 0;
  const isError = !pending && tokens.length === 0 && known === 0 && ((countError && count === undefined) || slotQs.some((q) => q.isError));
  return { tokens, isLoading, isLoadingMore, complete: !!pad && !pending, isError, count: known, total: n ?? known };
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
