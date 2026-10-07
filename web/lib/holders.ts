"use client";

import { useQuery } from "@tanstack/react-query";

/** How many wallets hold a token, through the site's own route: counted from
 *  the chain (contracts such as the pad and the pool taken off), or by the
 *  chain's explorer where the chain is not indexed. null while unknown or
 *  when nothing answers. `partial` while an old coin's history is still
 *  being read: the count so far, asked again in seconds. */
export type HoldersInfo = { holders: number | null; transfers: number | null; launched: number | null; partial: boolean };

const NONE: HoldersInfo = { holders: null, transfers: null, launched: null, partial: false };

export function useHolders(chainId: number, token: `0x${string}`, enabled = true) {
  return useQuery({
    queryKey: ["holders", chainId, token],
    enabled,
    queryFn: async (): Promise<HoldersInfo> => {
      try {
        const r = await fetch(`/api/holders?chain=${chainId}&token=${token}`);
        if (r.ok) return { ...NONE, ...((await r.json()) as Partial<HoldersInfo>) };
      } catch {}
      return NONE;
    },
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.partial ? 6_000 : 60_000),
  });
}
