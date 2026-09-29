"use client";
import Link from "next/link";
import { isFrozen, useMigrated, type LState } from "@/lib/litecoin/client";

/** A freeze announced for the migration: until the chain reaches it the
 *  ledger is live and the notice says when it stops; from then on the coins
 *  trade on LitVM, and every Litecoin page points there (to the coin itself
 *  once the migration has published where each one lives). */
export function FrozenNotice({ state, ticker, compact = false }: { state: LState | null | undefined; ticker?: string; compact?: boolean }) {
  const migrated = useMigrated().data;
  if (!state?.freezeHeight) return null;
  const token = ticker ? migrated?.tokens?.[ticker] : undefined;
  const href = token ? `/token/${token}` : "/";
  if (!isFrozen(state)) {
    const left = state.freezeHeight - (state.chainTip ?? state.height);
    return (
      <div className={`rounded-xl border border-white/30 bg-black ${compact ? "p-3 text-xs" : "p-4 text-sm"} space-y-1`}>
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Freezes at block {state.freezeHeight.toLocaleString("en-US")}</div>
        <p className="text-zinc-300">
          This ledger migrates to LitVM: in about {left.toLocaleString("en-US")} block{left === 1 ? "" : "s"} (~{Math.round((left * 2.5) / 60)} h) it stops taking buys,
          sells and deploys, and every coin is recreated there with the same holders and the same price. Trading here goes on until then.
        </p>
      </div>
    );
  }
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
