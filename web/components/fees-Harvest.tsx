"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useBlockNumber, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { migratorAbi, type PoolInfo } from "@/lib/pool";
import { useAppChain, useLaunchpadAddress } from "@/lib/hooks";
import { fmtTokens, fmtUnits } from "@/lib/format";
import { refreshAfterTrade } from "@/components/TradeBox";

/** The Harvest button of a graduated v12 coin. Anyone may call the migrator's
 *  harvest(token): it sells a slice of the coins waiting in the pad's two
 *  buckets on the pool (harvestCap: half a percent of the pool's quote side,
 *  once a block; once a freeze is announced, both buckets whole in one call,
 *  uncapped), burns the burn share, deepens the locked liquidity, and the pad
 *  pays the treasury, the creator and the holders; the caller keeps a
 *  twentieth of the treasury's part. Disabled while nothing waits, while the
 *  last harvest's block has not passed (not once a freeze is announced), while
 *  the pad holds no liquidity in the pool (the migrator has nothing to sell
 *  into), and from the freeze block on (the pad stands still). */
export function Harvest({
  token,
  symbol,
  pool,
  noPool,
  pending,
  quoteSymbol,
  quoteDecimals,
}: {
  token: `0x${string}`;
  symbol: string;
  /** the coin's pool as usePool reads it; undefined while it is being read, or when the pad seeded none */
  pool: PoolInfo | undefined;
  /** usePool's `none`: the pad seeded no pool for this coin */
  noPool: boolean;
  /** what the two buckets hold together, in coins; undefined while they are being read */
  pending: bigint | undefined;
  quoteSymbol: string;
  quoteDecimals: number;
}) {
  const chain = useAppChain();
  const { isConnected } = useAccount();
  const queryClient = useQueryClient();
  const migrator = pool?.migrator;

  // the block the next harvest may run from, the slice it may sell, and whether the
  // pad's liquidity is in the pool at all (parked at another price: nothing to sell into)
  const { data: reads } = useReadContracts({
    contracts: migrator
      ? [
          { address: migrator, abi: migratorAbi, functionName: "nextHarvestBlock", args: [token], chainId: chain.id },
          { address: migrator, abi: migratorAbi, functionName: "harvestCap", args: [token], chainId: chain.id },
          { address: migrator, abi: migratorAbi, functionName: "liquidity", args: [token], chainId: chain.id },
        ]
      : [],
    query: { enabled: !!migrator, refetchInterval: 15_000 },
  });
  const big = (i: number): bigint | undefined => {
    const r = (reads as readonly { status: string; result?: unknown }[] | undefined)?.[i];
    return r?.status === "success" ? (r.result as bigint) : undefined;
  };
  const nextBlock = big(0);
  const cap = big(1);
  const locked = big(2);
  const { data: blockNumber } = useBlockNumber({ chainId: chain.id, query: { enabled: !!migrator, refetchInterval: 5_000 } });
  // a freeze announced lifts the cap and the once-a-block rule (harvestCap still says the slice:
  // only harvest() looks at the freeze), so the buckets can be emptied before the snapshot; from
  // the freeze block the pad refuses the harvest
  const pad = useLaunchpadAddress();
  const { data: freezeRaw } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "freezeBlock",
    chainId: chain.id,
    query: { enabled: !!pad && !!migrator, refetchInterval: 15_000 },
  });
  const freezeBlock = freezeRaw as bigint | undefined;
  const rush = freezeBlock !== undefined && freezeBlock !== 0n;
  const frozen = rush && blockNumber !== undefined && blockNumber >= freezeBlock;

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: chain.id });
  // a confirmed harvest moved the buckets, the pool's reserves, the pots and the creator's
  // and holders' claimables: ask for all of it now, and for the block the next one may run from
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isSuccess || !hash || handled.current === hash) return;
    handled.current = hash;
    refreshAfterTrade(queryClient);
    void queryClient.invalidateQueries({ queryKey: ["blockNumber"] });
  }, [isSuccess, hash, queryClient]);

  const cooling = !rush && nextBlock !== undefined && blockNumber !== undefined && nextBlock > blockNumber;
  // why the button is off, in the order the migrator would refuse: no pool, the pad frozen, no
  // liquidity of ours in it, nothing in the buckets, a harvest already this block
  const state = noPool
    ? "noPool"
    : !pool || locked === undefined || nextBlock === undefined || pending === undefined || freezeBlock === undefined
      ? "reading"
      : frozen
        ? "frozen"
        : locked === 0n
          ? "unseeded"
          : pending === 0n
            ? "empty"
            : cooling
              ? "cooling"
              : "ready";
  const cannot = {
    noPool: "Its pool is not seeded yet: nothing to sell into",
    reading: "Reading the pool…",
    frozen: "The launchpad stands still from its freeze block: nothing can be harvested",
    unseeded: "The pad holds no liquidity in the pool: nothing to sell into",
    empty: "Nothing waiting: the buckets fill as the pool trades",
    cooling: `A slice went this block; the next may go from block ${nextBlock}`,
    ready: null,
  }[state];
  // what the next harvest takes from the buckets, and what that is worth at the pool's
  // price (an estimate: the burn share is burned, not sold, and the sale moves the price)
  const waiting = pending ?? 0n; // "ready" has read it
  const capped = !rush && cap !== undefined && cap < waiting;
  const slice = capped ? cap : waiting;
  const worth = pool && pool.tokenReserve > 0n ? (slice * pool.quoteReserve) / pool.tokenReserve : undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] text-zinc-600">
          {state === "ready" ? (
            <>
              Next harvest takes {fmtTokens(slice)} ${symbol}
              {worth !== undefined && <> ≈ {fmtUnits(worth, quoteDecimals)} {quoteSymbol}</>}
              {capped ? " · a slice a block" : rush && " · all of it: a freeze is announced"}
            </>
          ) : state === "cooling" ? (
            "A slice went this block; what is left goes the next."
          ) : state === "frozen" ? (
            "The launchpad stands still: harvests ended at the freeze block."
          ) : (
            "Anyone may harvest; the caller keeps a twentieth of the treasury's part."
          )}
        </div>
        <button
          type="button"
          disabled={!migrator || !isConnected || !!cannot || isPending || isConfirming}
          onClick={() => {
            reset();
            if (!migrator) return;
            writeContract({ address: migrator, abi: migratorAbi, functionName: "harvest", chainId: chain.id, args: [token] });
          }}
          className="btn-primary px-4 py-1.5 text-xs shrink-0"
          title={
            cannot ??
            "Sells a slice of the fees waiting in coins (half a percent of the pool at most, once a block; all of it at once, uncapped, after a freeze is announced), burns the burn share, deepens the liquidity, pays the treasury, the creator and the holders. Anyone may; the caller keeps a twentieth of the treasury's part."
          }
        >
          {isPending ? "Sign…" : isConfirming ? "Harvesting…" : state === "cooling" ? "Next block" : "Harvest"}
        </button>
      </div>
      {isSuccess && (
        <p className="text-xs text-zinc-400">
          {rush
            ? "Harvested what was waiting: the treasury is paid, the creator's and the holders' shares are claimable."
            : "Harvested a slice: the treasury is paid, the creator's and the holders' shares are claimable. What is left goes the next block."}
        </p>
      )}
      {error && (
        <p className="text-xs text-zinc-400 break-all">⚠ {(error as { shortMessage?: string }).shortMessage ?? error.message}</p>
      )}
    </div>
  );
}
