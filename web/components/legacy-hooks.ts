"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { launchpadV11Abi, launchTokenAbi } from "@/lib/abi";
import { isHiddenToken, type LegacyPad } from "@/lib/config";
import { NO_TAX, parseFeeConfig, type FeeConfig } from "@/lib/curve";
import { IMMUTABLE, META_REFETCH, parseCurve, parseMeta, type CurveInfo, type TokenMeta } from "@/lib/hooks";

/** A coin on a legacy pad: what the page lists of it, with the fees its
 *  trades on the curve still pay there (feeConfig as v11 stores it, six
 *  fields; the pad's feeBps() as the platform rate). */
export type LegacyToken = {
  address: `0x${string}`;
  name: string;
  symbol: string;
  curve: CurveInfo;
  meta: TokenMeta;
  feesToHolders: boolean;
  fees: FeeConfig;
};

type Read = { status: string; result?: unknown };
const REFETCH = { refetchInterval: 5_000 } as const;

/** The coins of a legacy pad, read with the v11 ABI: the shape of useTokens
 *  (lib/hooks.ts) against another pad. Three round trips: the count, the
 *  slots, then names, curves, fees and metadata together. The list is
 *  append-only and the pad takes no new coins, so the slots are read once.
 *  Also the pad's platform rate, feeBps(), which a sell quote needs. */
export function useLegacyTokens(pad: LegacyPad, chainId: number) {
  const address = pad.address;

  const { data: count, isPending: countPending, isError: countError } = useReadContract({
    address,
    abi: launchpadV11Abi,
    functionName: "tokenCount",
    chainId,
    query: REFETCH,
  });
  const { data: feeBpsRaw } = useReadContract({
    address,
    abi: launchpadV11Abi,
    functionName: "feeBps",
    chainId,
    query: IMMUTABLE,
  });

  const n = Number(count ?? 0n);
  const slots = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      address,
      abi: launchpadV11Abi,
      functionName: "allTokens" as const,
      args: [BigInt(i)] as const,
      chainId,
    })),
    query: { enabled: n > 0, ...IMMUTABLE },
  });
  const slotReads = slots.data as readonly Read[] | undefined;
  const tokenAddrs = useMemo(() => {
    const seen = new Set<string>();
    const out: `0x${string}`[] = [];
    for (const r of slotReads ?? []) {
      if (r.status !== "success") continue;
      const a = r.result as `0x${string}`;
      if (seen.has(a.toLowerCase()) || isHiddenToken(chainId, a)) continue;
      seen.add(a.toLowerCase());
      out.push(a);
    }
    return out;
  }, [slotReads, chainId]);

  // name, symbol, fee mode and fee configuration never change: read once
  const { data: statics, isLoading: staticsLoading } = useReadContracts({
    contracts: tokenAddrs.flatMap((t) => [
      { address: t, abi: launchTokenAbi, functionName: "name" as const, chainId },
      { address: t, abi: launchTokenAbi, functionName: "symbol" as const, chainId },
      { address, abi: launchpadV11Abi, functionName: "feesToHolders" as const, args: [t] as const, chainId },
      // reverts on pads before v9: a coin without a tax
      { address, abi: launchpadV11Abi, functionName: "feeConfig" as const, args: [t] as const, chainId },
    ]),
    query: { enabled: tokenAddrs.length > 0, ...IMMUTABLE },
  });
  const { data: metas } = useReadContracts({
    contracts: tokenAddrs.map((t) => ({ address, abi: launchpadV11Abi, functionName: "tokenMetadata" as const, args: [t] as const, chainId })),
    query: { enabled: tokenAddrs.length > 0, ...META_REFETCH },
  });
  const { data: curves, isLoading: curvesLoading } = useReadContracts({
    contracts: tokenAddrs.map((t) => ({ address, abi: launchpadV11Abi, functionName: "curves" as const, args: [t] as const, chainId })),
    query: { enabled: tokenAddrs.length > 0, ...REFETCH },
  });

  const platformFeeBps = (feeBpsRaw as bigint | undefined) ?? 100n; // v11's rate until read: 1%
  const tokens: LegacyToken[] = useMemo(() => {
    if (!statics || !curves) return [];
    const staticReads = statics as readonly Read[];
    const curveReads = curves as readonly Read[];
    const metaReads = metas as readonly Read[] | undefined;
    const covered = Math.min(tokenAddrs.length, Math.floor(staticReads.length / 4), curveReads.length);
    return tokenAddrs
      .slice(0, covered)
      .map((addr, i) => {
        const name = staticReads[i * 4];
        const symbol = staticReads[i * 4 + 1];
        const feeMode = staticReads[i * 4 + 2];
        const feesR = staticReads[i * 4 + 3];
        const curve = curveReads[i];
        const meta = metaReads?.[i];
        if (name?.status !== "success" || symbol?.status !== "success" || curve?.status !== "success") return null;
        const feesToHolders = feeMode?.status === "success" ? (feeMode.result as boolean) : false;
        return {
          address: addr,
          name: name.result as string,
          symbol: symbol.result as string,
          curve: parseCurve(curve.result),
          meta:
            meta?.status === "success"
              ? parseMeta(meta.result)
              : { logoURI: "", website: "", twitter: "", telegram: "", livestream: "", description: "" },
          feesToHolders,
          fees:
            feesR?.status === "success"
              ? parseFeeConfig(feesR.result, Number(platformFeeBps))
              : { ...NO_TAX, platformBps: Number(platformFeeBps), creatorBps: feesToHolders ? 0 : 10_000, holdersBps: feesToHolders ? 10_000 : 0 },
        };
      })
      .filter((t): t is LegacyToken => t !== null)
      .reverse(); // newest first, as Explore lists them
  }, [statics, curves, metas, tokenAddrs, platformFeeBps]);

  // the quote assets the pad's coins trade in, each once: what creator fees accrue in there
  const quoteAssets = useMemo(() => {
    const seen = new Set<string>();
    const out: `0x${string}`[] = [];
    for (const t of tokens) {
      const key = t.curve.quoteAsset.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t.curve.quoteAsset);
    }
    return out;
  }, [tokens]);

  const isLoading = countPending || (n > 0 && slots.isPending) || (tokenAddrs.length > 0 && (staticsLoading || curvesLoading));
  const isError = countError || slots.isError;
  return { tokens, quoteAssets, platformFeeBps, isLoading, isError, count: n };
}
