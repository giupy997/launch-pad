"use client";

import { useQuery } from "@tanstack/react-query";

/** LTC in fiat, from the site (five-minute cache); null while unknown. cbLTC
 *  and zkLTC are LTC one to one, so the same price reads their amounts. */
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

/** "$12.3K" — the way meme-coin caps are read. */
export function fmtUsd(n: number): string {
  if (!(n > 0)) return "$0";
  if (n < 1_000) return `$${n.toFixed(n < 10 ? 2 : 0)}`;
  if (n < 1_000_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n < 1_000_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${(n / 1_000_000_000).toFixed(2)}B`;
}

/** Whether a quote asset is Litecoin by another name, so the LTC price reads it. */
export function isLtcQuote(symbol: string): boolean {
  return /ltc/i.test(symbol);
}

/** An amount of the quote asset as the pages show money: in dollars when the
 *  quote is LTC and its price is known, else in the quote itself. */
export function fmtQuoteMoney(amount: bigint, decimals: number, symbol: string, usd: number | null | undefined): string {
  const units = Number(amount) / 10 ** decimals;
  if (usd && isLtcQuote(symbol)) return fmtUsd(units * usd);
  const digits = units >= 100 ? 0 : units >= 1 ? 2 : 4;
  return `${units.toFixed(digits)} ${symbol}`;
}
