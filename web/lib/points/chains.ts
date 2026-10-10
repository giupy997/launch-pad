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
  /** the nodes among `rpcs` that serve the chain's whole history (a keyed
   *  one): the only ones a trade scan asks for a long span in one request */
  archive: string[];
  /** the quote's decimals: 18 for native zkLTC, 8 for cbLTC */
  quoteDecimals: number;
  quoteSymbol: string;
  blockSeconds: number;
  /** blocks one eth_getLogs may cover on the first of `rpcs`; what each
   *  node takes is learned per node from its refusals */
  chunk: bigint;
  /** blocks the indexer stays behind the head, so a reorg never credits twice */
  lag: bigint;
  /** coins that don't count, lowercase */
  hidden: `0x${string}`[];
  /** the season on this chain; null for a chain indexed but not scored */
  season: PointsSeason | null;
  explorer: string;
};

/** Base nodes with a key, for the server alone: `BASE_RPC_URLS` in the
 *  site's environment (Netlify), comma-separated, never in the repo. The
 *  public nodes no longer serve a coin's whole history to a server (Base's
 *  rations by IP and takes 500 blocks a call, publicnode only recent blocks),
 *  so with none a scan over old blocks can stall. In the browser this is
 *  empty: the browser scans the public nodes, short spans, by itself. */
const KEYED_BASE = (process.env.BASE_RPC_URLS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => /^https:\/\//.test(s));

export const POINTS_CHAINS: Record<string, PointsChain> = {
  // LitVM's Liteforge testnet: the v11 rehearsal pad, quoted in native zkLTC
  // (a 0.05 zkLTC virtual reserve at first, so that curves graduated on faucet
  // money; 0.9375 zkLTC, 3 to graduate, for the coins created from 2026-10-10). Season 0, the rehearsal, from the pad's deploy block until LitVM
  // mainnet opens (the v9 pad's season, 56,991,201 on, was wiped with it).
  liteforge: {
    key: "liteforge",
    chainId: 4441,
    name: "LitVM Liteforge testnet",
    pad: "0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F",
    deployBlock: 57_741_789n,
    rpcs: ["https://liteforge.rpc.caldera.xyz/infra-partner-http"],
    archive: [], // not tried in one request over a long span: the chain's node has not been measured for it
    quoteDecimals: 18,
    quoteSymbol: "zkLTC",
    blockSeconds: 0.25, // measured on the live chain: ~4 blocks a second (Orbit's 250 ms)
    chunk: 9_000n, // the node took these whole during the backfill
    lag: 60n,
    hidden: [],
    season: { number: 0, name: "Season 0", start: 57_741_789n, end: null, rehearsal: true },
    explorer: "https://liteforge.explorer.caldera.xyz",
  },
  // Base: the v12 pad in cbLTC (the v11 pad 0xEfbB…b5f4, block 52,180,589, is
  // not indexed: it was replaced, its coins left where they trade). No season here (the features
  // come with LitVM); indexed only when enabled, for a one-off genesis credit at Season 1.
  base: {
    key: "base",
    chainId: 8453,
    name: "Base",
    pad: "0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5",
    deployBlock: 52_397_620n,
    rpcs: [...KEYED_BASE, "https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"],
    archive: KEYED_BASE,
    quoteDecimals: 8,
    quoteSymbol: "cbLTC",
    blockSeconds: 2,
    // a keyed node takes 10,000 blocks a call; the public ones name their own cap, learned per node
    chunk: KEYED_BASE.length ? 9_999n : 1_999n,
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
