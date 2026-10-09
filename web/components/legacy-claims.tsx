"use client";

import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchpadV11Abi } from "@/lib/abi";
import type { LegacyPad } from "@/lib/config";
import { fmtUnits } from "@/lib/format";
import { quoteInfo, useAppChain } from "@/lib/hooks";

/** The claim button and its outcome, shared by both claims below. */
function ClaimButton({ onClick, isPending, isConfirming }: { onClick: () => void; isPending: boolean; isConfirming: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={isPending || isConfirming}
      className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black hover:bg-zinc-100 transition-colors disabled:opacity-40"
    >
      {isPending ? "Sign…" : isConfirming ? "Claiming…" : "Claim"}
    </button>
  );
}

function ClaimError({ error }: { error: Error | null }) {
  if (!error) return null;
  return <p className="mt-1 text-xs text-zinc-500 break-all">{(error as { shortMessage?: string }).shortMessage ?? error.message}</p>;
}

/** The connected wallet's cashback on a coin of a legacy pad (CashbackCard
 *  against that pad, with its ABI): the holders' share of the pot its curve
 *  trades left, still claimable there. Nothing while it is zero. */
export function LegacyCashback({
  pad,
  token,
  quote,
}: {
  pad: LegacyPad;
  token: `0x${string}`;
  quote: { symbol: string; decimals: number };
}) {
  const chainId = useAppChain().id;
  const { address: user } = useAccount();
  const { data: claimable, isError } = useReadContract({
    address: pad.address,
    abi: launchpadV11Abi,
    functionName: "cashbackOf",
    args: user ? [token, user] : undefined,
    chainId,
    query: { enabled: !!user, refetchInterval: 10_000 },
  });
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  if (!user || isError || claimable === undefined) return null;
  const amount = claimable as bigint;
  if (amount === 0n && !isSuccess) return null;

  return (
    <div>
      <div className="label">Holder cashback</div>
      <div className="mt-1 flex items-center gap-3">
        <span className="font-semibold">
          {fmtUnits(amount, quote.decimals)} {quote.symbol}
        </span>
        {amount > 0n && (
          <ClaimButton
            onClick={() => {
              reset();
              writeContract({ address: pad.address, abi: launchpadV11Abi, functionName: "claimCashback", chainId, args: [token] });
            }}
            isPending={isPending}
            isConfirming={isConfirming}
          />
        )}
        {isSuccess && <span className="text-xs text-zinc-400">claimed ✓</span>}
      </div>
      <ClaimError error={error} />
    </div>
  );
}

/** The connected wallet's creator fees on a legacy pad, one row per quote
 *  asset its coins trade in (CreatorFees against that pad, with its ABI).
 *  Nothing while every row is zero. */
export function LegacyCreatorFees({ pad, quoteAssets }: { pad: LegacyPad; quoteAssets: `0x${string}`[] }) {
  const chainId = useAppChain().id;
  const { address: user } = useAccount();
  const { data, isError } = useReadContracts({
    contracts: quoteAssets.map((asset) => ({
      address: pad.address,
      abi: launchpadV11Abi,
      functionName: "creatorFees" as const,
      args: [user ?? "0x0000000000000000000000000000000000000000", asset] as const,
      chainId,
    })),
    query: { enabled: !!user && quoteAssets.length > 0, refetchInterval: 10_000 },
  });
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  if (!user || isError || !data) return null;
  const reads = data as readonly { status: string; result?: unknown }[];
  const rows = quoteAssets
    .map((asset, i) => ({ asset, q: quoteInfo(chainId, asset), amount: reads[i]?.status === "success" ? (reads[i].result as bigint) : 0n }))
    .filter((r) => r.amount > 0n);
  if (rows.length === 0 && !isSuccess) return null;

  return (
    <div className="rounded-xl border border-white/10 px-5 py-3">
      <div className="label">Creator earnings</div>
      {rows.map(({ asset, q, amount }) => (
        <div key={asset} className="mt-0.5 flex items-center gap-3">
          <span className="font-semibold">
            {fmtUnits(amount, q.decimals)} {q.symbol}
          </span>
          <ClaimButton
            onClick={() => {
              reset();
              writeContract({ address: pad.address, abi: launchpadV11Abi, functionName: "claimCreatorFees", chainId, args: [asset] });
            }}
            isPending={isPending}
            isConfirming={isConfirming}
          />
        </div>
      ))}
      {isSuccess && <span className="text-xs text-zinc-400">claimed ✓</span>}
      <ClaimError error={error} />
      <p className="mt-1 text-[11px] text-zinc-600">The creator&apos;s share of the curve trades&apos; fees on your coins here, as you set it at launch.</p>
    </div>
  );
}
