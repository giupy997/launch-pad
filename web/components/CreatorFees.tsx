"use client";

import {
  useAccount,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { useLaunchpadAddress, useAppChain, usePadVersion, ZERO_ADDRESS } from "@/lib/hooks";
import { QUOTE_ASSETS } from "@/lib/config";
import { fmtUnits } from "@/lib/format";

/** Accrued creator fee earnings per quote asset, with claim buttons: the
 *  creator's share of the coin's tax (on v11, of the pot the platform fee
 *  left). Renders nothing on deployments without creator fees. */
export function CreatorFees() {
  const pad = useLaunchpadAddress();
  const chain = useAppChain();
  const v12 = usePadVersion() === 12;
  const { address: user } = useAccount();
  const assets = QUOTE_ASSETS[chain.id] ?? [{ address: null, symbol: chain.nativeCurrency.symbol, decimals: 18 }];

  const { data, isError } = useReadContracts({
    contracts: assets.map((a) => ({
      address: pad,
      abi: launchpadAbi,
      functionName: "creatorFees" as const,
      args: [user ?? ZERO_ADDRESS, a.address ?? ZERO_ADDRESS] as const,
      chainId: chain.id, // the app chain's pad, not the wallet's chain
    })),
    query: { enabled: !!pad && !!user, refetchInterval: 10_000 },
  });

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: chain.id });

  if (!pad || !user || isError || !data) return null;

  const rows = assets
    .map((a, i) => ({
      asset: a,
      amount: data[i]?.status === "success" ? (data[i].result as bigint) : 0n,
    }))
    .filter((r, i) => i === 0 || r.amount > 0n); // always show ETH row

  return (
    <div className="rounded-xl border border-white/10 px-5 py-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
        Creator earnings
      </div>
      {rows.map(({ asset, amount }) => (
        <div key={asset.symbol} className="mt-0.5 flex items-center gap-3">
          <span className="font-semibold">
            {fmtUnits(amount, asset.decimals)} {asset.symbol}
          </span>
          {amount > 0n && (
            <button
              onClick={() => {
                reset();
                writeContract({
                  address: pad,
                  abi: launchpadAbi,
                  functionName: "claimCreatorFees",
                  chainId: chain.id,
                  args: [asset.address ?? ZERO_ADDRESS],
                });
              }}
              disabled={isPending || isConfirming}
              className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black hover:bg-zinc-100 transition-colors disabled:opacity-40"
            >
              {isPending ? "Sign…" : isConfirming ? "Claiming…" : "Claim"}
            </button>
          )}
        </div>
      ))}
      {isSuccess && <span className="text-xs text-zinc-400">claimed ✓</span>}
      {error && (
        <p className="mt-1 text-xs text-zinc-500 break-all">
          {(error as { shortMessage?: string }).shortMessage ?? error.message}
        </p>
      )}
      {v12 ? (
        <>
          <p className="mt-1 text-[11px] text-zinc-600">
            The creator&apos;s share of every trade&apos;s tax on your coins, on the curve and on the pool, as you set it at launch.
          </p>
          <p className="text-[11px] text-zinc-600">
            Fees taken on a pool wait in coins until someone harvests them: each coin&apos;s page shows what is pending.
          </p>
        </>
      ) : (
        <p className="mt-1 text-[11px] text-zinc-600">The creator&apos;s share of every curve trade&apos;s fee on your coins, as you set it at launch.</p>
      )}
    </div>
  );
}
