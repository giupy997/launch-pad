// The chains the points service indexes, one entry each: the pad to read, the
// block it was deployed at, the public RPCs in order, how the quote is
// denominated, and the season running there. Kept in step with lib/config.ts
// by hand: that module pulls wagmi in, which a Node process does not want.

export type PointsSeason = {
  number: number;
  name: string;
  /** the first block that counts (the pad's deploy block, usually) */
  start: bigint;
  /** the last block that counts; null while the season is open (a
   *  FreezeAnnounced on the pad closes it at the announced block) */
  end: bigint | null;
  /** a testnet run: worth nothing, says so on the page, wiped at the end */
  rehearsal: boolean;
};

export type PointsChain = {
  key: string;
  chainId: number;
  name: string;
  pad: `0x${string}`;
  deployBlock: bigint;
  rpcs: string[];
  /** the quote's decimals: 18 for native zkLTC, 8 for cbLTC */
  quoteDecimals: number;
  quoteSymbol: string;
  blockSeconds: number;
  /** blocks one eth_getLogs may cover on the chain's public nodes; learned
   *  smaller from a refusal */
  chunk: bigint;
  /** blocks the indexer stays behind the head, so a reorg never credits twice */
  lag: bigint;
  /** coins that don't count, lowercase */
  hidden: `0x${string}`[];
  /** the season on this chain; null for a chain indexed but not scored */
  season: PointsSeason | null;
  explorer: string;
};

export const POINTS_CHAINS: Record<string, PointsChain> = {
  // LitVM's Liteforge testnet: the v7.7 pad, quoted in native zkLTC. Season 0,
  // the rehearsal, from the pad's deploy block until LitVM mainnet opens.
  liteforge: {
    key: "liteforge",
    chainId: 4441,
    name: "LitVM Liteforge testnet",
    pad: "0x4D3C63F873bc2aC79E529C8003321d60643a4025",
    deployBlock: 55_934_572n,
    rpcs: ["https://liteforge.rpc.caldera.xyz/infra-partner-http"],
    quoteDecimals: 18,
    quoteSymbol: "zkLTC",
    blockSeconds: 0.25, // measured on the live chain: ~4 blocks a second (Orbit's 250 ms)
    chunk: 9_000n, // the node took these whole during the backfill
    lag: 60n,
    hidden: [],
    season: { number: 0, name: "Season 0", start: 55_934_572n, end: null, rehearsal: true },
    explorer: "https://liteforge.explorer.caldera.xyz",
  },
  // Base: the v9 pad in cbLTC. No season here (the features come with
  // LitVM); indexed only when enabled, for a one-off genesis credit at Season 1.
  base: {
    key: "base",
    chainId: 8453,
    name: "Base",
    pad: "0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF",
    deployBlock: 52_045_689n,
    rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"],
    quoteDecimals: 8,
    quoteSymbol: "cbLTC",
    blockSeconds: 2,
    chunk: 1_999n,
    lag: 60n,
    hidden: [],
    season: null,
    explorer: "https://base.blockscout.com",
  },
};

/** the chain that scores points for a wagmi chain id, if any */
export function pointsChainById(chainId: number): PointsChain | null {
  for (const c of Object.values(POINTS_CHAINS)) if (c.chainId === chainId && c.season) return c;
  return null;
}
