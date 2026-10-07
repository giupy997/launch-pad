"use client";

import { useQuery } from "@tanstack/react-query";

/** One holder of a coin: the balance in wei, and whether the address is a
 *  contract (the pad with the unsold supply, the pool) rather than a wallet. */
export type Holder = { address: `0x${string}`; balance: bigint; contract: boolean };

/** Who holds a token, through the site's own route: counted from the chain
 *  (contracts such as the pad and the pool taken off the count, named in
 *  `top`), or by the chain's explorer where the chain is not indexed (a count
 *  alone). null while unknown or when nothing answers. `partial` while the
 *  count is not final (an old coin's history still being read, a read that
 *  failed): the count so far, asked again in seconds. */
export type HoldersInfo = { holders: number | null; launched: number | null; partial: boolean; top: Holder[] };

const NONE: HoldersInfo = { holders: null, launched: null, partial: false, top: [] };

type Wire = Partial<Omit<HoldersInfo, "top">> & { chain?: number; token?: string; top?: { a: string; b: string; c: boolean }[] };

export function useHolders(chainId: number, token: `0x${string}`, enabled = true) {
  // one entry at the edge and in this cache however the address is written
  const addr = token.toLowerCase() as `0x${string}`;
  return useQuery({
    queryKey: ["holders", chainId, addr],
    enabled,
    queryFn: async (): Promise<HoldersInfo> => {
      try {
        const r = await fetch(`/api/holders?chain=${chainId}&token=${addr}`);
        if (r.ok) {
          const j = (await r.json()) as Wire;
          // an answer for another coin or chain (a cache gone wrong) is no answer
          if ((j.token && j.token.toLowerCase() !== addr) || (j.chain !== undefined && j.chain !== chainId)) return NONE;
          return {
            ...NONE,
            ...j,
            top: (j.top ?? []).map((h) => ({ address: h.a as `0x${string}`, balance: BigInt(h.b), contract: !!h.c })),
          };
        }
      } catch {}
      return NONE;
    },
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.partial ? 6_000 : 60_000),
  });
}
