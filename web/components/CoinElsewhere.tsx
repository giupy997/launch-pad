"use client";

import { useEffect } from "react";
import { useAccount, useReadContracts, useSwitchChain } from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { LAUNCHPAD_ADDRESS, VISIBLE_CHAINS } from "@/lib/config";
import { useAppChain } from "@/lib/hooks";

/** What the coin's page shows when the launchpad of the chain the app is on
 *  does not know the address: the coin may be a coin of the other chain's
 *  launchpad (a link to a testnet coin opened by a visitor whose app is on
 *  Base, the default, read "Token not found"). One read of `curves` on each
 *  other chain's launchpad settles it. A visitor without a wallet is taken
 *  there at once, since the choice of chain is only the app's; one with a
 *  wallet connected is asked, since the switch is a request to the wallet. */
export function CoinElsewhere({ token }: { token: `0x${string}` }) {
  const chain = useAppChain();
  const { isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();
  const others = VISIBLE_CHAINS.filter((c) => c.id !== chain.id && LAUNCHPAD_ADDRESS[c.id]);
  const { data, isLoading } = useReadContracts({
    contracts: others.map((c) => ({
      address: LAUNCHPAD_ADDRESS[c.id]!,
      abi: launchpadAbi,
      functionName: "curves" as const,
      args: [token] as const,
      chainId: c.id,
    })),
    query: { enabled: others.length > 0, staleTime: Infinity },
  });
  // a coin the launchpad created has a virtual reserve; an address it never saw reads zero
  const home = others.find((_, i) => data?.[i]?.status === "success" && (data[i].result as readonly unknown[])[0] !== 0n);
  const homeId = home?.id;
  useEffect(() => {
    if (homeId !== undefined && !isConnected) switchChain({ chainId: homeId });
  }, [homeId, isConnected, switchChain]);

  if (others.length > 0 && isLoading) return <p className="text-zinc-500">Looking for this coin…</p>;
  if (!home) return <p className="text-zinc-500">Token not found on this launchpad.</p>;
  return (
    <div className="card p-5 space-y-3 max-w-xl">
      <p className="text-sm text-zinc-300">
        This coin is on {home.name}, not on {chain.name}.
      </p>
      <button type="button" className="btn-primary px-4 py-1.5 text-xs" disabled={isPending} onClick={() => switchChain({ chainId: home.id })}>
        {isPending ? "Switching…" : `Open it on ${home.name}`}
      </button>
    </div>
  );
}
