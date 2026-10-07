"use client";

import { fmtTokens, shortAddr } from "@/lib/format";
import type { Holder } from "@/lib/holders";

const SUPPLY = 1_000_000_000n * 10n ** 18n; // every coin mints a billion

/** Who holds the coin, largest first: the wallets, and the contracts named
 *  for what they are (the curve's unsold supply, the pool, the burn). */
export function HolderList({
  holders,
  total,
  partial,
  loading,
  symbol,
  labels,
  explorer,
}: {
  /** the largest holders, contracts included */
  holders: Holder[];
  /** wallets with a balance, the contracts taken off; null while unknown */
  total: number | null;
  /** the count is still being made: what is here is so far */
  partial: boolean;
  loading: boolean;
  symbol: string;
  /** what the known addresses are, by lowercase address: the creator, the pad, the pool */
  labels: Record<string, string>;
  explorer: string;
}) {
  const shown = holders.slice(0, 50);
  const walletsShown = shown.filter((h) => !h.contract).length;
  const more = total !== null ? total - walletsShown : 0;
  return (
    <div className="rounded-xl border border-white/10 bg-black">
      {shown.length === 0 && (
        <p className="px-4 py-6 text-sm text-zinc-600">
          {loading || partial
            ? "Reading the chain…"
            : total === null
              ? "The chain is not answering right now; trying again."
              : total > 0
                ? `${total.toLocaleString("en-US")} wallet${total === 1 ? "" : "s"} hold the coin; the list is not available on this chain.`
                : "No holders yet."}
        </p>
      )}
      <ol className="divide-y divide-white/[0.06]">
        {shown.map((h, i) => {
          const label = labels[h.address.toLowerCase()] ?? (h.contract ? "Contract" : null);
          const pct = Number((h.balance * 10_000n) / SUPPLY) / 100;
          return (
            <li key={h.address} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-5 font-mono text-xs text-zinc-600">{i + 1}</span>
              <a
                href={`${explorer}/address/${h.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-zinc-300 underline hover:text-white"
              >
                {shortAddr(h.address)}
              </a>
              {label && (
                <span className="rounded-full border border-white/20 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-zinc-400">{label}</span>
              )}
              <span className="flex-1" />
              <span className="hidden text-zinc-400 sm:block">
                {fmtTokens(h.balance)} {symbol}
              </span>
              <span className="w-20 text-right">
                <span className="font-mono text-xs text-zinc-200">{pct < 0.01 ? "<0.01" : pct.toFixed(2)}%</span>
                <span className="mt-1 block bar-track">
                  <span className="block h-full rounded-full bg-white" style={{ width: `${Math.min(100, pct)}%` }} />
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {shown.length > 0 && (partial || more > 0) && (
        <p className="border-t border-white/[0.06] px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-zinc-600">
          {partial ? "still counting…" : `${more.toLocaleString("en-US")} more wallet${more === 1 ? "" : "s"}`}
        </p>
      )}
    </div>
  );
}
