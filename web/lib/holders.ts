"use client";

import { useQuery } from "@tanstack/react-query";

/** How many addresses hold a token, as the chain's explorer counts them (the
 *  pad and the pool included: the caller takes them off), through the site's
 *  own route. null while unknown or when the explorer does not answer. */
export type HoldersInfo = { holders: number | null; transfers: number | null; launched: number | null };

export function useHolders(chainId: number, token: `0x${string}`, enabled = true) {
  return useQuery({
    queryKey: ["holders", chainId, token],
    enabled,
    queryFn: async (): Promise<HoldersInfo> => {
      try {
        const r = await fetch(`/api/holders?chain=${chainId}&token=${token}`);
        if (r.ok) return (await r.json()) as HoldersInfo;
      } catch {}
      return { holders: null, transfers: null, launched: null };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
