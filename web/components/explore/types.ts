import type { TokenInfo } from "@/lib/hooks";

/** What the explore page knows of a coin beyond its on-chain record: the
 *  figures every section sorts and ranks by, computed once by the page. */
export type CoinStats = {
  /** market cap in quote units (the pool's for a graduated coin) */
  mcap: number;
  /** quote units per whole coin */
  price: number;
  /** the last day's trading in quote wei; undefined while unknown */
  volume24h: bigint | undefined;
  /** price change over the day in percent; null when the day had no trade */
  change24h: number | null;
  /** the last trade, unix seconds; null when none in the day */
  lastTrade: number | null;
  /** the curve's progress, 0 to 100 (100 once graduated) */
  progress: number;
};

/** what a coin is quoted in: its market cap, price and volume are in this */
export type Quote = { symbol: string; decimals: number };

export type Coin = { token: TokenInfo; stats: CoinStats; quote: Quote };
