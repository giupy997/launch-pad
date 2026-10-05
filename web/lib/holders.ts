"use client";

import { useQuery } from "@tanstack/react-query";

/** How many addresses hold a token, as the chain's explorer counts them (the
 *  pad and the pool included: the caller takes them off), through the site's
 *  own route. null while unknown or when the explorer does not answer. */
export function useHolders(chainId: number, token: `0x${string}`) {
  return useQuery({
    queryKey: ["holders", chainId, token],
    queryFn: async (): Promise<{ holders: number | null; transfers: number | null }> => {
      try {
        const r = await fetch(`/api/holders?chain=${chainId}&token=${token}`);
        if (r.ok) return (await r.json()) as { holders: number | null; transfers: number | null };
      } catch {}
      return { holders: null, transfers: null };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
