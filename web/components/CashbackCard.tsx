"use client";

import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { useLaunchpadAddress, useAppChain } from "@/lib/hooks";
import { fmtUnits } from "@/lib/format";

/** Holder cashback (80% of trade fees on rewards-mode tokens, pro-rata) for the connected wallet.
 *  Renders nothing on deployments that predate the cashback system. */
export function CashbackCard({
  token,
  quoteSymbol = "ETH",
  quoteDecimals = 18,
}: {
  token: `0x${string}`;
  quoteSymbol?: string;
  quoteDecimals?: number;
}) {
  const pad = useLaunchpadAddress();
  const appChainId = useAppChain().id;
  const { address: user } = useAccount();

  const { data: claimable, isError } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "cashbackOf",
    args: user ? [token, user] : undefined,
    query: { enabled: !!pad && !!user, refetchInterval: 10_000 },
  });

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  if (!pad || !user || isError || claimable === undefined) return null;

  const amount = claimable as bigint;

  return (
    <div className="rounded-xl border border-zinc-800 bg-black p-5">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
        Holder cashback
      </div>
      <div className="mt-1 flex items-center gap-3">
        <span className="font-semibold">{fmtUnits(amount, quoteDecimals)} {quoteSymbol}</span>
        {amount > 0n && (
          <button
            onClick={() => {
              reset();
              writeContract({
                address: pad,
                abi: launchpadAbi,
                functionName: "claimCashback",
                chainId: appChainId,
                args: [token],
              });
            }}
            disabled={isPending || isConfirming}
            className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black hover:bg-zinc-200 disabled:opacity-40"
          >
            {isPending ? "Sign…" : isConfirming ? "Claiming…" : "Claim"}
          </button>
        )}
        {isSuccess && <span className="text-xs text-zinc-400">claimed ✓</span>}
      </div>
      <p className="mt-1 text-[11px] text-zinc-600">
        80% of every trade fee is shared pro-rata with holders.
      </p>
      {error && (
        <p className="mt-1 text-xs text-zinc-500 break-all">
          {(error as { shortMessage?: string }).shortMessage ?? error.message}
        </p>
      )}
    </div>
  );
}
