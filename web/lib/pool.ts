"use client";

import { parseAbi } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { launchpadAbi } from "./abi";
import type { PoolRef } from "./events";
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

/** how often an incomplete read of the pool is asked again */
const RETRY_MS = 5_000;
const allOk = (reads: readonly { status: string }[] | undefined, n: number) =>
  reads !== undefined && reads.length === n && reads.every((r) => r.status === "success");

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
  /** whether the coin is the pair's token0 (its swaps' amount0 is the coin) */
  tokenIsZero: boolean;
  /** the share of the pool's liquidity the pad's migrator holds locked, in percent */
  lockedPct: number;
};

/** A graduated coin's pool, read from the chain in three steps: the pad says
 *  which migrator seeded it, the migrator which pair, the pair what it holds.
 *  The reserves poll; the rest never changes once graduated. `none` is a
 *  graduated coin the pad seeded no pool for (no migrator at the time, or a
 *  pad too old to say). */
export function usePool(pad: `0x${string}`, token: `0x${string}`, chainId: number, enabled: boolean) {
  // immutable once graduated, but a node that fails one read must not leave the
  // page on "reading the pool" for good: an incomplete answer is asked again
  const via = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "graduatedVia",
    args: [token],
    chainId,
    query: { enabled, ...IMMUTABLE, refetchInterval: (q) => (q.state.data ? false : RETRY_MS) },
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
    query: {
      enabled: !!migrator,
      ...IMMUTABLE,
      refetchInterval: (q) => (allOk(q.state.data as readonly { status: string }[] | undefined, 3) ? false : RETRY_MS),
    },
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
      tokenIsZero,
      lockedPct: lpTotal > 0n ? Number((lpOurs * 10_000n) / lpTotal) / 100 : 0,
    };
  }
  // no pool at all: no migrator recorded, or the migrator knows no pair (a read that
  // failed is retried above, not read as "no pool")
  const none =
    enabled && (via.isError || via.data === ZERO_ADDRESS || seat.isError || (seated && !pair) || live.isError);
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

/** The pools of several graduated coins at once, for reading their swaps
 *  along with the pad's trades (the explore page's volumes): the pad says
 *  which migrator seeded each, the migrator which pair, the pair which side
 *  the coin is. Immutable once graduated. Coins with no pool are left out. */
export function usePools(pad: `0x${string}`, tokens: `0x${string}`[], chainId: number): { pools: PoolRef[]; ready: boolean } {
  const vias = useReadContracts({
    contracts: tokens.map((t) => ({ address: pad, abi: launchpadAbi, functionName: "graduatedVia" as const, args: [t] as const, chainId })),
    query: { enabled: tokens.length > 0, ...IMMUTABLE },
  });
  type Read = { status: string; result?: unknown };
  const viaReads = (vias.data as readonly Read[] | undefined) ?? [];
  const seated = tokens
    .map((token, i) => ({ token, migrator: viaReads[i]?.status === "success" ? (viaReads[i].result as `0x${string}`) : undefined }))
    .filter((x): x is { token: `0x${string}`; migrator: `0x${string}` } => !!x.migrator && x.migrator !== ZERO_ADDRESS);
  const pairs = useReadContracts({
    contracts: seated.map((x) => ({ address: x.migrator, abi: migratorAbi, functionName: "pairOf" as const, args: [x.token] as const, chainId })),
    query: { enabled: seated.length > 0, ...IMMUTABLE },
  });
  const pairReads = (pairs.data as readonly Read[] | undefined) ?? [];
  const paired = seated
    .map((x, i) => ({ ...x, pair: pairReads[i]?.status === "success" ? (pairReads[i].result as `0x${string}`) : undefined }))
    .filter((x): x is { token: `0x${string}`; migrator: `0x${string}`; pair: `0x${string}` } => !!x.pair && x.pair !== ZERO_ADDRESS);
  const sides = useReadContracts({
    contracts: paired.map((x) => ({ address: x.pair, abi: pairAbi, functionName: "token0" as const, chainId })),
    query: { enabled: paired.length > 0, ...IMMUTABLE },
  });
  const sideReads = (sides.data as readonly Read[] | undefined) ?? [];
  // settled: every round that had something to read has answered (so a volume scan
  // that waits for the pools runs once, with them, not once without and once with)
  const ready =
    tokens.length === 0 ||
    (vias.data !== undefined && (seated.length === 0 || pairs.data !== undefined) && (paired.length === 0 || sides.data !== undefined));
  const pools = paired
    .map((x, i) => ({
      token: x.token,
      pair: x.pair,
      token0: sideReads[i]?.status === "success" ? (sideReads[i].result as `0x${string}`) : undefined,
    }))
    .filter((x): x is { token: `0x${string}`; pair: `0x${string}`; token0: `0x${string}` } => !!x.token0)
    .map((x) => ({ token: x.token, pair: x.pair, tokenIsZero: x.token0.toLowerCase() === x.token.toLowerCase() }));
  return { pools, ready };
}
