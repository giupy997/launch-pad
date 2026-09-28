"use client";

import { useAppChain, useLaunchpadAddress } from "@/lib/hooks";

/** Shown on launchpad pages when the selected chain has no deployment yet. */
export function NotDeployedNotice() {
  const chain = useAppChain();
  const pad = useLaunchpadAddress();
  if (pad) return null;
  return (
    <div className="card p-4 mb-8 text-sm text-zinc-300">
      <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 block mb-1">
        {chain.name}
      </span>
      The launchpad is not deployed on this chain yet. Switch chain from the
      selector in the header, or check back soon.
    </div>
  );
}
