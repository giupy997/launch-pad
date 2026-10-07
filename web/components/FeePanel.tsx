"use client";

import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { useLaunchpadAddress, useAppChain } from "@/lib/hooks";
import { feesLine, splitParts, type FeeConfig } from "@/lib/curve";
import { fmtUnits, fmtTokens } from "@/lib/format";

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

/** A coin's fees as its creator fixed them, and where they have gone: the
 *  pots waiting to be spent and the coins burned so far. Anyone may spend the
 *  burn pot. Renders for pads that know fee configurations (v9 and on). */
export function FeePanel({
  token,
  symbol,
  fees,
  platformFeeBps,
  treasury,
  burnPot,
  liquidityPot,
  burned,
  quoteSymbol,
  quoteDecimals,
  graduated,
}: {
  token: `0x${string}`;
  symbol: string;
  fees: FeeConfig;
  platformFeeBps: bigint;
  treasury: string;
  burnPot: bigint;
  liquidityPot: bigint;
  burned: bigint;
  quoteSymbol: string;
  quoteDecimals: number;
  graduated: boolean;
}) {
  const pad = useLaunchpadAddress();
  const chain = useAppChain();
  const { isConnected } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const parts = splitParts(fees);
  const burnedPct = Number((burned * 10_000n) / TOTAL_SUPPLY) / 100;
  // a burn needs somewhere to buy: the curve, or a pool the migrator seeded; and a coin fully delivered
  const { data: state } = useReadContracts({
    contracts: [
      { address: pad, abi: launchpadAbi, functionName: "graduatedVia", args: [token] },
      { address: pad, abi: launchpadAbi, functionName: "migrationPending", args: [token] },
    ],
    query: { enabled: !!pad, refetchInterval: 15_000 },
  });
  const via = state?.[0]?.status === "success" ? (state[0].result as `0x${string}`) : undefined;
  const pending = state?.[1]?.status === "success" ? (state[1].result as bigint) : 0n;
  const noPool = graduated && via !== undefined && /^0x0{40}$/.test(via);
  const cannotBurn = noPool ? "Its pool is not seeded yet: nothing to buy from" : pending > 0n ? "Its holders are still being delivered" : null;

  return (
    <div className="card p-5 space-y-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Fees</div>
      <div className="font-mono text-xs text-zinc-300">{feesLine(platformFeeBps, fees)}</div>
      <div className="space-y-1.5">
        {parts.map((p) => (
          <div key={p.key} className="flex items-center gap-3 text-xs">
            <span className="w-28 text-zinc-500 capitalize">{p.label}</span>
            <span className="flex-1 h-1.5 rounded bg-white/[0.06] overflow-hidden">
              <span className="block h-full bg-white" style={{ width: `${p.bps / 100}%` }} />
            </span>
            <span className="w-10 text-right font-mono text-zinc-300">{p.bps / 100}%</span>
          </div>
        ))}
        <p className="text-[11px] text-zinc-600">
          Of every trade, {treasury} goes to the treasury; the rest of the fee is split as above.
        </p>
      </div>

      {(fees.burnBps > 0 || burnPot > 0n) && (
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
          <div>
            <div className="text-xs text-zinc-500">Buyback pot</div>
            <div className="font-mono text-sm text-white">
              {fmtUnits(burnPot, quoteDecimals)} {quoteSymbol}
            </div>
          </div>
          <button
            type="button"
            disabled={!pad || !isConnected || burnPot === 0n || !!cannotBurn || isPending || isConfirming}
            onClick={() => {
              reset();
              if (!pad) return;
              writeContract({ address: pad, abi: launchpadAbi, functionName: "buybackAndBurn", chainId: chain.id, args: [token] });
            }}
            className="btn-primary px-4 py-1.5 text-xs"
            title={cannotBurn ?? "Buys the coin back with a slice of the pot and burns it: a hundredth of the curve, or half a percent of the pool, once a block. Anyone may."}
          >
            {isPending ? "Sign…" : isConfirming ? "Burning…" : "Burn now"}
          </button>
        </div>
      )}
      {(fees.liquidityBps > 0 || liquidityPot > 0n) && !graduated && (
        <div className="border-t border-white/[0.06] pt-3">
          <div className="text-xs text-zinc-500">Liquidity pot · joins the pool at graduation</div>
          <div className="font-mono text-sm text-white">
            {fmtUnits(liquidityPot, quoteDecimals)} {quoteSymbol}
          </div>
        </div>
      )}
      {burned > 0n && (
        <div className="border-t border-white/[0.06] pt-3">
          <div className="text-xs text-zinc-500">Burned so far</div>
          <div className="font-mono text-sm text-white">
            {fmtTokens(burned)} ${symbol} <span className="text-zinc-500">· {burnedPct}% of the supply</span>
          </div>
        </div>
      )}
      {isSuccess && <p className="text-xs text-zinc-400">Burned a slice. What is left in the pot goes the next block.</p>}
      {error && (
        <p className="text-xs text-zinc-400 break-all">⚠ {(error as { shortMessage?: string }).shortMessage ?? error.message}</p>
      )}
    </div>
  );
}
