"use client";

import { LEGACY_LAUNCHPADS } from "@/lib/config";
import { useAppChain } from "@/lib/hooks";
import { LegacyPadSection } from "@/components/legacy-pad";

/** The pads this chain moved on from (LEGACY_LAUNCHPADS), each with its
 *  coins as they stand and what the connected wallet can still do there.
 *  Rendered in the browser from the chain; page.tsx (server) is the shell. */
export function LegacyPage() {
  const chain = useAppChain();
  const pads = LEGACY_LAUNCHPADS[chain.id] ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <header className="space-y-4">
        <div className="pill">Legacy</div>
        <h1 className="display text-4xl sm:text-5xl text-white">Previous launchpads</h1>
        {pads.length > 0 && (
          <p className="text-base leading-relaxed text-zinc-400">
            The coins created on an earlier launchpad on {chain.name} keep trading where they are: on their curve through that pad,
            or in the pool it seeded. Their cashback and creator fees stay claimable here.
          </p>
        )}
      </header>
      {pads.length === 0 ? (
        <p className="text-zinc-500">No previous launchpad on this chain.</p>
      ) : (
        pads.map((pad) => <LegacyPadSection key={pad.address} pad={pad} />)
      )}
    </div>
  );
}
