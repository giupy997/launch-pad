"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useReadContracts } from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { BLOCK_SECONDS, MIGRATION_TARGET } from "@/lib/config";
import { useAppChain, useLaunchpadAddress } from "@/lib/hooks";
import { useNow } from "@/lib/useNow";

/** Where a chain's migrated coins live on the other side, published with the
 *  site after the migration as /migrated/<chainId>.json (absent until then). */
function useMigratedFrom(chainId: number) {
  return useQuery({
    queryKey: ["migrated-from", chainId],
    queryFn: async (): Promise<{ tokens: Record<string, `0x${string}`> } | null> => {
      try {
        const r = await fetch(`/migrated/${chainId}.json`);
        if (r.ok) return (await r.json()) as { tokens: Record<string, `0x${string}`> };
      } catch {}
      return null;
    },
    staleTime: 5 * 60_000,
  });
}

/** The pad's migration to another chain, as its v8 contracts announce it: a
 *  freeze block ahead means trading stops there and every coin is re-created
 *  on the other side with the same holders and price; once landed, the pad
 *  stands still and this points to the coin's new home when it is known.
 *  Pads without the feature (older deployments) render nothing. */
export function MigrationNotice({ token, symbol, compact = false }: { token?: `0x${string}`; symbol?: string; compact?: boolean }) {
  const chain = useAppChain();
  const pad = useLaunchpadAddress();
  const now = useNow();
  const target = MIGRATION_TARGET[chain.id];
  const { data } = useReadContracts({
    contracts: [
      // the app chain's pad, not the wallet's chain
      { address: pad, abi: launchpadAbi, functionName: "freezeBlock", chainId: chain.id },
      { address: pad, abi: launchpadAbi, functionName: "frozen", chainId: chain.id },
      ...(token ? [{ address: pad, abi: launchpadAbi, functionName: "migratedOut" as const, args: [token] as const, chainId: chain.id }] : []),
    ],
    query: { enabled: !!pad && !!target, refetchInterval: 15_000 },
  });
  const { data: block } = useQuery({
    queryKey: ["block-number", chain.id, Math.floor(now / 15)],
    queryFn: async () => {
      const r = await fetch(chain.rpcUrls.default.http[0], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const j = (await r.json()) as { result: string };
      return Number(BigInt(j.result));
    },
    enabled: !!data && data[0]?.status === "success" && (data[0].result as bigint) !== 0n,
    staleTime: 10_000,
  });
  const migrated = useMigratedFrom(chain.id).data;
  if (!target || !data || data[0]?.status !== "success") return null;
  const freezeBlock = Number(data[0].result as bigint);
  if (freezeBlock === 0) return null;
  const frozen = data[1]?.status === "success" && (data[1].result as boolean);
  const movedOut = token && data[2]?.status === "success" && (data[2].result as boolean);
  const twin = symbol ? migrated?.tokens?.[symbol] : undefined;
  const pad_ = compact ? "p-3 text-xs" : "p-4 text-sm";

  if (!frozen) {
    const left = block ? Math.max(0, freezeBlock - block) : null;
    const hours = left !== null ? (left * (BLOCK_SECONDS[chain.id] ?? 2)) / 3600 : null;
    return (
      <div className={`rounded-xl border border-white/30 bg-black ${pad_} space-y-1`}>
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Migration to {target} · freezes at block {freezeBlock.toLocaleString("en-US")}</div>
        <p className="text-zinc-300">
          {left !== null ? `In about ${left.toLocaleString("en-US")} blocks (~${hours! < 1 ? `${Math.round(hours! * 60)} min` : `${hours!.toFixed(hours! < 10 ? 1 : 0)} h`}) ` : "At that block "}
          this launchpad stands still and every coin is re-created on {target} with the same holders and the same price, its pool
          included. Trading here goes on until then; nothing to do on your side, unless you hold liquidity in a pool other
          than the one the launchpad seeded: withdraw it before that block, after which it cannot be taken out.
        </p>
      </div>
    );
  }
  return (
    <div className={`rounded-xl border border-white bg-black ${pad_} space-y-2`}>
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Frozen at block {freezeBlock.toLocaleString("en-US")} · moving to {target}</div>
      <p className="text-zinc-300">
        This launchpad stopped at that block: {symbol ? `$${symbol}` : "every coin"} is being re-created on {target} with the same
        holders and the same price{movedOut ? "; its reserve has left for the bridge" : ""}. Cashback and creator fees earned here stay claimable here.
      </p>
      {twin ? (
        <Link href={`/token/${twin}`} className="inline-block btn-primary px-4 py-1.5 text-xs">
          Trade ${symbol} on {target}
        </Link>
      ) : (
        <p className="text-zinc-500">The link to its new home appears here as soon as the coins are live there.</p>
      )}
    </div>
  );
}
