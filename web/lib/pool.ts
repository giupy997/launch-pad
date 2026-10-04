"use client";

import { parseAbi } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { launchpadAbi } from "./abi";
import { IMMUTABLE, ZERO_ADDRESS } from "./hooks";

/** What the site reads of a UniV2Migrator: the pool it seeded for a coin,
 *  what the coin is paired against there, the liquidity it holds locked. */
export const migratorAbi = parseAbi([
  "function pairOf(address token) view returns (address)",
  "function pairAsset(address token) view returns (address)",
  "function liquidity(address token) view returns (uint256)",
  "function router() view returns (address)",
]);

/** What the site reads of a Uniswap v2 pair. */
export const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
]);

export type PoolInfo = {
  migrator: `0x${string}`;
  pair: `0x${string}`;
  /** the Uniswap v2 router the migrator seeds through: the one to swap on */
  router: `0x${string}`;
  /** what the coin is paired against in the pool: the quote, wrapped for a native curve */
  pairAsset: `0x${string}`;
  /** the pool's two sides, as (coin, quote) whatever their order in the pair */
  tokenReserve: bigint;
  quoteReserve: bigint;
  /** the share of the pool's liquidity the pad's migrator holds locked, in percent */
  lockedPct: number;
};

/** A graduated coin's pool, read from the chain in three steps: the pad says
 *  which migrator seeded it, the migrator which pair, the pair what it holds.
 *  The reserves poll; the rest never changes once graduated. `none` is a
 *  graduated coin the pad seeded no pool for (no migrator at the time, or a
 *  pad too old to say). */
export function usePool(pad: `0x${string}`, token: `0x${string}`, chainId: number, enabled: boolean) {
  const via = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "graduatedVia",
    args: [token],
    chainId,
    query: { enabled, ...IMMUTABLE },
  });
  const migrator = via.data && via.data !== ZERO_ADDRESS ? via.data : undefined;

  const seat = useReadContracts({
    contracts: migrator
      ? [
          { address: migrator, abi: migratorAbi, functionName: "pairOf", args: [token], chainId },
          { address: migrator, abi: migratorAbi, functionName: "pairAsset", args: [token], chainId },
          { address: migrator, abi: migratorAbi, functionName: "router", chainId },
        ]
      : [],
    query: { enabled: !!migrator, ...IMMUTABLE },
  });
  const firstSeat = (seat.data as readonly { status: string; result?: unknown }[] | undefined)?.[0];
  const pairRead = firstSeat?.status === "success" ? (firstSeat.result as `0x${string}`) : undefined;
  const pair = pairRead && pairRead !== ZERO_ADDRESS ? pairRead : undefined;

  const live = useReadContracts({
    contracts:
      pair && migrator
        ? [
            { address: pair, abi: pairAbi, functionName: "getReserves", chainId },
            { address: pair, abi: pairAbi, functionName: "token0", chainId },
            { address: pair, abi: pairAbi, functionName: "totalSupply", chainId },
            { address: migrator, abi: migratorAbi, functionName: "liquidity", args: [token], chainId },
          ]
        : [],
    query: { enabled: !!pair, refetchInterval: 15_000 },
  });

  // the result arrays are typed from the (possibly empty) contracts tuple above: read them loosely
  type Read = { status: string; result?: unknown };
  const liveReads = live.data as readonly Read[] | undefined;
  const seatReads = seat.data as readonly Read[] | undefined;
  let data: PoolInfo | undefined;
  const seated = seatReads !== undefined && seatReads.length === 3 && seatReads.every((r) => r.status === "success");
  if (pair && migrator && seated && liveReads && liveReads.length === 4 && liveReads.every((r) => r.status === "success")) {
    const [reserve0, reserve1] = liveReads[0].result as readonly [bigint, bigint, number];
    const token0 = liveReads[1].result as `0x${string}`;
    const lpTotal = liveReads[2].result as bigint;
    const lpOurs = liveReads[3].result as bigint;
    const tokenIsZero = token0.toLowerCase() === token.toLowerCase();
    data = {
      migrator,
      pair,
      pairAsset: seatReads![1].result as `0x${string}`,
      router: seatReads![2].result as `0x${string}`,
      tokenReserve: tokenIsZero ? reserve0 : reserve1,
      quoteReserve: tokenIsZero ? reserve1 : reserve0,
      lockedPct: lpTotal > 0n ? Number((lpOurs * 10_000n) / lpTotal) / 100 : 0,
    };
  }
  const none =
    enabled &&
    (via.isError || via.data === ZERO_ADDRESS || seat.isError || (seat.data !== undefined && !pair) || live.isError);
  const isPending = enabled && !data && !none;
  return { data, isPending, none };
}

/** The pool's price in quote units per whole coin. */
export function poolPriceOf(pool: PoolInfo, quoteDecimals: number): number {
  if (pool.tokenReserve === 0n) return 0;
  return Number(pool.quoteReserve) / 10 ** quoteDecimals / (Number(pool.tokenReserve) / 1e18);
}

/** Fully diluted market cap at the pool's price: times the 1B supply. */
export function poolMarketCapOf(pool: PoolInfo, quoteDecimals: number): number {
  return poolPriceOf(pool, quoteDecimals) * 1_000_000_000;
}
