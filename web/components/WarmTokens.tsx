"use client";

import { useTokens } from "@/lib/hooks";

/** Reads another chain's token list into the cache, once and without
 *  polling, so that switching there finds the list ready instead of a second
 *  or two of placeholders. Renders nothing. */
export function WarmTokens({ chainId }: { chainId: number }) {
  useTokens(chainId, { warm: true });
  return null;
}
