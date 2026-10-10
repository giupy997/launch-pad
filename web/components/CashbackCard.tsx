"use client";

import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { useLaunchpadAddress, useAppChain, useNativeSymbol, usePadVersion } from "@/lib/hooks";
import { fmtUnits } from "@/lib/format";

/** Holder cashback for the connected wallet: the holders' share of the
 *  coin's tax, pro-rata (on v11, of the pot the platform fee left). Renders
 *  nothing on deployments that predate the cashback system. */
export function CashbackCard({
  token,
  quoteSymbol: quoteSymbolProp,
  quoteDecimals = 18,
}: {
  token: `0x${string}`;
  quoteSymbol?: string;
  quoteDecimals?: number;
}) {
  const pad = useLaunchpadAddress();
  const native = useNativeSymbol();
  const quoteSymbol = quoteSymbolProp ?? native;
  const appChainId = useAppChain().id;
  const v12 = usePadVersion() === 12;
  const { address: user } = useAccount();

  const { data: claimable, isError } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "cashbackOf",
    args: user ? [token, user] : undefined,
    chainId: appChainId, // the app chain's pad, not the wallet's chain
    query: { enabled: !!pad && !!user, refetchInterval: 10_000 },
  });

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: appChainId });

  if (!pad || !user || isError || claimable === undefined) return null;

  const amount = claimable as bigint;

  return (
    <div className="card p-5">
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
            className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black hover:bg-zinc-100 transition-colors disabled:opacity-40"
          >
            {isPending ? "Sign…" : isConfirming ? "Claiming…" : "Claim"}
          </button>
        )}
        {isSuccess && <span className="text-xs text-zinc-400">claimed ✓</span>}
      </div>
      <p className="mt-1 text-[11px] text-zinc-600">
        {v12
          ? "The holders' share of the coin's own tax on every trade, on the curve and, once graduated, on the pool after a harvest; pro-rata to what each wallet holds, as the coin's creator set it."
          : "The holders' share of every curve trade's fee, pro-rata to what each wallet holds, as the coin's creator set it."}
      </p>
      {error && (
        <p className="mt-1 text-xs text-zinc-500 break-all">
          {(error as { shortMessage?: string }).shortMessage ?? error.message}
        </p>
      )}
    </div>
  );
}
