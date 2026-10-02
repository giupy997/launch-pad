// What the points service answers, as the site reads it. Pure types: shared
// by the service (web/lib/points/indexer.ts) and the browser (client.ts).

import type { LedgerKind } from "./rules.ts";

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
  indexed: { last: string; head: string; lagBlocks: number; trades: number; coins: number; graduations: number; wallets: number; referrals: number };
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
