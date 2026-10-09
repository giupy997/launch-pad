"use client";

import type { LegacyPad } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { useAppChain, useExplorer } from "@/lib/hooks";
import { LegacyCreatorFees } from "@/components/legacy-claims";
import { LegacyCoin } from "@/components/legacy-coin";
import { useLegacyTokens } from "@/components/legacy-hooks";

/** One pad the chain moved on from: what it is, its coins as they stand,
 *  and the connected wallet's creator fees there. */
export function LegacyPadSection({ pad }: { pad: LegacyPad }) {
  const chain = useAppChain();
  const explorer = useExplorer();
  const { tokens, quoteAssets, platformFeeBps, isLoading, isError, count } = useLegacyTokens(pad, chain.id);

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <h2 className="display text-2xl text-white">{pad.label}</h2>
        <a href={`${explorer}/address/${pad.address}`} target="_blank" rel="noreferrer" className="font-mono text-xs text-zinc-400 underline" title={pad.address}>
          {shortAddr(pad.address)} ↗
        </a>
        <p className="text-sm text-zinc-400">
          This launchpad was replaced by the one the site runs on. Its coins stay here, trading as before; nothing moves by itself.
        </p>
        {pad.migratedTo && <p className="text-sm text-zinc-400">Its coins were moved to {pad.migratedTo}.</p>}
      </header>

      <LegacyCreatorFees pad={pad} quoteAssets={quoteAssets} />

      {isError && tokens.length === 0 ? (
        <p className="text-sm text-zinc-500">Could not read this launchpad. Try again in a moment.</p>
      ) : isLoading && tokens.length === 0 ? (
        <p className="text-sm text-zinc-500">Reading the launchpad…</p>
      ) : count === 0 ? (
        <p className="text-sm text-zinc-500">No coins on this launchpad.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {tokens.map((t) => (
            <LegacyCoin key={t.address} pad={pad} token={t} platformFeeBps={platformFeeBps} />
          ))}
        </div>
      )}
    </section>
  );
}
