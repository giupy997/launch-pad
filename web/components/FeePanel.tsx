"use client";

import { useAccount, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { useLaunchpadAddress, useAppChain, usePadVersion, ZERO_ADDRESS } from "@/lib/hooks";
import { feesLine, splitParts, treasuryPct, type FeeConfig } from "@/lib/curve";
import { fmtUnits, fmtTokens } from "@/lib/format";
import { usePool } from "@/lib/pool";
import { Harvest } from "@/components/fees-Harvest";

const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

/** A coin's fees as its creator fixed them, and where they have gone: the
 *  pots waiting to be spent and the coins burned so far. Anyone may spend the
 *  burn pot. On a v12 pad a graduated coin's pool fees wait in coins until a
 *  harvest sells them: the two buckets, and the button, show here too.
 *  Renders for pads that know fee configurations (v9 and on). */
export function FeePanel({
  token,
  symbol,
  fees,
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
  const v12 = usePadVersion() === 12;
  const { isConnected } = useAccount();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: chain.id });
  const parts = splitParts(fees);
  const burnedPct = Number((burned * 10_000n) / TOTAL_SUPPLY) / 100;
  // a burn needs somewhere to buy: the curve, or a pool the migrator seeded; and a coin fully delivered.
  // Read on the app chain, as every read here: wagmi would otherwise ask the wallet's
  const { data: state } = useReadContracts({
    contracts: [
      { address: pad, abi: launchpadAbi, functionName: "graduatedVia", args: [token], chainId: chain.id },
      { address: pad, abi: launchpadAbi, functionName: "migrationPending", args: [token], chainId: chain.id },
    ],
    query: { enabled: !!pad, refetchInterval: 15_000 },
  });
  const via = state?.[0]?.status === "success" ? (state[0].result as `0x${string}`) : undefined;
  const pending = state?.[1]?.status === "success" ? (state[1].result as bigint) : 0n;
  const noPool = graduated && via !== undefined && /^0x0{40}$/.test(via);
  const cannotBurn = noPool ? "Its pool is not seeded yet: nothing to buy from" : pending > 0n ? "Its holders are still being delivered" : null;

  // v12, after graduation: the coins the token took on pool trades, waiting in the pad's two
  // buckets (the launchpad's rate, the coin's tax) until a harvest sells them; and the pool,
  // whose price says what they are worth
  const harvesting = v12 && graduated;
  const { data: buckets } = useReadContracts({
    contracts: [
      { address: pad, abi: launchpadAbi, functionName: "taxTreasury", args: [token], chainId: chain.id },
      { address: pad, abi: launchpadAbi, functionName: "taxPot", args: [token], chainId: chain.id },
    ],
    query: { enabled: !!pad && harvesting, refetchInterval: 15_000 },
  });
  // undefined until read: an unread bucket is not an empty one
  const bucketTreasury = buckets?.[0]?.status === "success" ? (buckets[0].result as bigint) : undefined;
  const bucketPot = buckets?.[1]?.status === "success" ? (buckets[1].result as bigint) : undefined;
  const pool = usePool(pad ?? ZERO_ADDRESS, token, chain.id, !!pad && harvesting);
  // an estimate: the pool's price before the sale moves it
  const worth = (coins: bigint): bigint | undefined =>
    pool.data && pool.data.tokenReserve > 0n ? (coins * pool.data.quoteReserve) / pool.data.tokenReserve : undefined;
  const share = (bps: number) => ((bucketPot ?? 0n) * BigInt(bps)) / 10_000n;
  const rate = treasuryPct(fees.platformBps); // the launchpad's rate as text, on v12 the coin's own stamp

  return (
    // the anchor the pool card points at when it says a harvest sells what the pool charges
    <div id="fees" className="card p-5 space-y-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Fees</div>
      <div className="font-mono text-xs text-zinc-300">{v12 ? `${rate} launchpad fee · ${feesLine(fees)}` : feesLine(fees)}</div>
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
          {v12
            ? `The launchpad's ${rate} goes whole to the treasury on every trade, on the curve and on the pool; the coin's tax is split as above.`
            : `Of every trade, ${treasury} goes to the treasury; the rest of the fee is split as above.`}
        </p>
      </div>

      {harvesting && (
        <div className="border-t border-white/[0.06] pt-3 space-y-2">
          <div className="text-xs text-zinc-500">Pool fees to harvest</div>
          {(
            [
              ["Launchpad fee", bucketTreasury],
              ["Coin's tax", bucketPot],
            ] as const
          ).map(([label, coins]) => {
            const q = coins === undefined ? undefined : worth(coins);
            return (
              <div key={label} className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-zinc-500">{label}</span>
                <span className="font-mono text-zinc-300 text-right">
                  {coins === undefined ? "…" : `${fmtTokens(coins)} $${symbol}`}
                  {q !== undefined && (
                    <span className="text-zinc-500">
                      {" "}
                      ≈ {fmtUnits(q, quoteDecimals)} {quoteSymbol}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {bucketPot !== undefined && bucketPot > 0n && parts.length > 0 && (
            <p className="text-[11px] text-zinc-600">
              The coin&apos;s tax, by its shares: {parts.map((p) => `${fmtTokens(share(p.bps))} ${p.label}`).join(" · ")}.
            </p>
          )}
          <Harvest
            token={token}
            symbol={symbol}
            pool={pool.data}
            noPool={pool.none}
            pending={bucketTreasury !== undefined && bucketPot !== undefined ? bucketTreasury + bucketPot : undefined}
            quoteSymbol={quoteSymbol}
            quoteDecimals={quoteDecimals}
          />
        </div>
      )}

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
      {/* after graduation the quote pot is in the pool; on v12 the share goes on, in coins, pool side at each harvest */}
      {harvesting && fees.liquidityBps > 0 && (
        <div className="border-t border-white/[0.06] pt-3">
          <div className="text-xs text-zinc-500">Liquidity share · deepens the pool at each harvest</div>
          <div className="font-mono text-sm text-white">
            {bucketPot === undefined ? "…" : `${fmtTokens(share(fees.liquidityBps))} $${symbol}`}{" "}
            <span className="text-zinc-500">· waiting; half kept, half sold, both sides into the locked liquidity</span>
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
