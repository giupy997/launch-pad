// What the points service answers, as the site reads it. Pure types: shared
// by the service (web/lib/points/indexer.ts) and the browser (client.ts).

import type { LedgerKind } from "./rules.ts";
import type { PackedTrade } from "../trades/scan.ts";

export type SeasonView = {
  chain: string;
  chainId: number;
  name: string;
  season: { number: number; name: string; start: string; end: string | null; rehearsal: boolean } | null;
  quoteSymbol: string;
  rules: {
    version: number;
    pointsPerQuote: number;
    holderBonusPct: number;
    creatorGraduation: number;
    earlyBuyers: number;
    earlyBuyer: number;
    inviterPct: number;
    inviteePct: number;
    inviteeDays: number;
  };
  indexed: {
    last: string;
    head: string;
    lagBlocks: number;
    trades: number;
    coins: number;
    graduations: number;
    wallets: number;
    referrals: number;
    /** the newest block whose coin transfers are counted: behind `last` while they are backfilled */
    transfersLast: string;
  };
  updatedAt: number | null;
  lastError: string | null;
};

export type LeaderboardRow = {
  rank: number;
  wallet: `0x${string}`;
  points: number;
  trades: number;
  /** quote moved, in its smallest unit, as a decimal string */
  volume: string;
  invitees: number;
};

export type LeaderboardResponse = {
  season: SeasonView["season"];
  updatedAt: number | null;
  rows: LeaderboardRow[];
};

/** one coin's trades on the pad's curve, as the site's feed packs them
 *  (lib/trades/scan.ts): oldest first, the block's time where the service
 *  has read it, 0 otherwise. Pool swaps after a graduation are not the pad's
 *  events: the site reads them from the chain, from `last` on. */
export type CoinTradesView = {
  chain: string;
  chainId: number;
  token: `0x${string}`;
  /** the newest block whose events are in the answer */
  last: string;
  /** the block the coin was created at; null for a coin the service does not know */
  created: string | null;
  /** the block it graduated at; null while on its curve */
  graduated: string | null;
  trades: PackedTrade[];
  updatedAt: number | null;
};

/** who holds one coin, from every Transfer of it the service has read: the
 *  wallets with a balance, the largest first, contracts among the largest
 *  (the pad, the pool) named and not counted. `partial` while the coins'
 *  transfers are still being read up to the pad's own block. */
export type CoinHoldersView = {
  chain: string;
  chainId: number;
  token: `0x${string}`;
  /** the newest block whose transfers are counted */
  last: string;
  created: string | null;
  graduated: string | null;
  /** the coin's birth, unix seconds; null while unknown */
  launched: number | null;
  holders: number;
  partial: boolean;
  /** address, balance in wei as a decimal string, whether it is a contract */
  top: { a: string; b: string; c: boolean }[];
  updatedAt: number | null;
};

export type WalletView = {
  wallet: `0x${string}`;
  rank: number | null;
  points: number;
  byKind: { kind: LedgerKind; label: string; points: number }[];
  trades: number;
  /** quote moved, in its smallest unit, as a decimal string */
  volume: string;
  inviter: `0x${string}` | null;
  invitees: { wallet: `0x${string}`; points: number }[];
  /** the block the invitee's own bonus lasts to, if bound */
  inviteeBonusUntil: string | null;
};
