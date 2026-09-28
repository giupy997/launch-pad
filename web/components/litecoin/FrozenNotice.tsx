"use client";
import Link from "next/link";
import { useMigrated, type LState } from "@/lib/litecoin/client";

/** Once the ledger is frozen for the migration, the coins trade on LitVM:
 *  every Litecoin page says so and points there (to the coin itself once
 *  the migration has published where each one lives). */
export function FrozenNotice({ state, ticker, compact = false }: { state: LState | null | undefined; ticker?: string; compact?: boolean }) {
  const migrated = useMigrated().data;
  if (!state?.freezeHeight) return null;
  const token = ticker ? migrated?.tokens?.[ticker] : undefined;
  const href = token ? `/token/${token}` : "/";
  return (
    <div className={`rounded-xl border border-white bg-black ${compact ? "p-3 text-xs" : "p-4 text-sm"} space-y-2`}>
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Frozen at block {state.freezeHeight.toLocaleString("en-US")}</div>
      <p className="text-zinc-300">
        This ledger stopped taking buys, sells and deploys at that block: {ticker ? `$${ticker} now trades` : "the coins now trade"} on
        LitVM, with the same holders and the same price. What the desk still owes here (claims, payouts) is paid on Litecoin as usual.
      </p>
      <Link href={href} className="inline-block btn-primary px-4 py-1.5 text-xs">
        {token ? `Trade $${ticker} on LitVM` : "Open Notus on LitVM"}
      </Link>
    </div>
  );
}
