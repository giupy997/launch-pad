// The rules of the points, as pure arithmetic over what the chain says: the
// trades, the coins and their graduations, the referral bindings. Nothing
// here reads a network or a file, so a season replays deterministically, and
// a change of weights is a change here plus a bump of RULES_VERSION (the
// service rebuilds its ledger when it sees a new one).
//
// Points are kept in thousandths ("milli") as bigints: exact sums and exact
// ranks, with 0.2 points for a 0.01 LTC trade instead of nothing.
// See POINTS.md for why these numbers.

import type { PointsSeason } from "./chains.ts";

export const RULES_VERSION = 1;

export const RULES = {
  /** 20 points per whole quote unit traded (one ten-thousandth of what reaches the treasury) */
  tradeMilliPerQuote: 20_000n,
  /** still holding a coin when it graduates: this much more on the points earned on it */
  holderBonusPct: 50n,
  /** the creator of a coin that graduates */
  creatorGraduationMilli: 2_000_000n,
  /** the first distinct buyers of a coin that graduates, and what each gets */
  earlyBuyers: 25,
  earlyBuyerMilli: 100_000n,
  /** the inviter's share of the invitee's trade points, for the season */
  inviterPct: 10n,
  /** the invitee's own bonus on trade points, and for how long after accepting */
  inviteePct: 5n,
  inviteeDays: 30,
} as const;

export type Side = "buy" | "sell";

export type Trade = {
  tx: `0x${string}`;
  logIndex: number;
  block: bigint;
  token: `0x${string}`;
  wallet: `0x${string}`;
  side: Side;
  /** the quote moved, in its smallest unit (paid on a buy, received on a sell) */
  quote: bigint;
  /** the coins moved, 18 decimals */
  tokens: bigint;
};

export type Coin = {
  token: `0x${string}`;
  creator: `0x${string}`;
  createdBlock: bigint;
  graduatedBlock: bigint | null;
};

export type Referral = {
  invitee: `0x${string}`;
  inviter: `0x${string}`;
  /** the chain's head when the binding was accepted: bonuses start here */
  block: bigint;
  /** unix seconds */
  ts: number;
};

export type LedgerKind = "trade" | "grad_holder" | "grad_creator" | "early" | "ref_inviter" | "ref_invitee";

export type LedgerEntry = {
  wallet: `0x${string}`;
  kind: LedgerKind;
  milli: bigint;
  token?: `0x${string}`;
  /** the trade this entry comes from, `tx:logIndex` */
  ref?: string;
  block: bigint;
};

export const KIND_LABELS: Record<LedgerKind, string> = {
  trade: "Trading",
  grad_holder: "Held through a graduation",
  grad_creator: "Created a coin that graduated",
  early: "Among the first buyers of a graduated coin",
  ref_inviter: "Invited traders",
  ref_invitee: "Invited, first 30 days",
};

/** the trade points of a quote amount, in thousandths */
export function tradeMilli(quote: bigint, quoteDecimals: number): bigint {
  return (quote * RULES.tradeMilliPerQuote) / 10n ** BigInt(quoteDecimals);
}

export function milliToPoints(milli: bigint): number {
  return Number(milli) / 1000;
}

/** how many blocks the invitee's bonus lasts on a chain */
export function inviteeBonusBlocks(blockSeconds: number): bigint {
  return BigInt(Math.round((RULES.inviteeDays * 86_400) / blockSeconds));
}

const byOrder = (a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }) =>
  a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1;

export type LedgerInput = {
  trades: Trade[];
  coins: Iterable<Coin>;
  referrals: Iterable<Referral>;
  season: PointsSeason;
  quoteDecimals: number;
  blockSeconds: number;
  /** coins that don't count, lowercase */
  hidden: Set<string>;
};

/** Every point of a season, entry by entry, from the chain's facts. */
export function computeLedger(input: LedgerInput): LedgerEntry[] {
  const { season, hidden } = input;
  const inSeason = (b: bigint) => b >= season.start && (season.end === null || b <= season.end);
  const trades = input.trades.filter((t) => inSeason(t.block) && !hidden.has(t.token.toLowerCase())).sort(byOrder);
  const out: LedgerEntry[] = [];

  // 1. trading: the base layer
  const milliOf = new Map<Trade, bigint>();
  for (const t of trades) {
    const m = tradeMilli(t.quote, input.quoteDecimals);
    milliOf.set(t, m);
    if (m > 0n) out.push({ wallet: low(t.wallet), kind: "trade", milli: m, token: t.token, ref: refOf(t), block: t.block });
  }

  // 2. graduations in the season: holders, the creator, the first buyers
  for (const c of input.coins) {
    if (c.graduatedBlock === null || !inSeason(c.graduatedBlock) || hidden.has(c.token.toLowerCase())) continue;
    const g = c.graduatedBlock;
    const coinTrades = trades.filter((t) => t.token.toLowerCase() === c.token.toLowerCase() && t.block <= g);
    // before graduation a coin only moves through the pad: a wallet's balance is its buys minus its sells
    const net = new Map<string, bigint>();
    const earned = new Map<string, bigint>();
    for (const t of coinTrades) {
      const w = low(t.wallet);
      net.set(w, (net.get(w) ?? 0n) + (t.side === "buy" ? t.tokens : -t.tokens));
      earned.set(w, (earned.get(w) ?? 0n) + (milliOf.get(t) ?? 0n));
    }
    for (const [w, n] of net) {
      if (n <= 0n) continue;
      const bonus = ((earned.get(w) ?? 0n) * RULES.holderBonusPct) / 100n;
      if (bonus > 0n) out.push({ wallet: w as `0x${string}`, kind: "grad_holder", milli: bonus, token: c.token, block: g });
    }
    out.push({ wallet: low(c.creator), kind: "grad_creator", milli: RULES.creatorGraduationMilli, token: c.token, block: g });
    const early = new Set<string>();
    for (const t of coinTrades) {
      if (t.side !== "buy") continue;
      const w = low(t.wallet);
      if (early.has(w)) continue;
      early.add(w);
      out.push({ wallet: w, kind: "early", milli: RULES.earlyBuyerMilli, token: c.token, ref: refOf(t), block: g });
      if (early.size >= RULES.earlyBuyers) break;
    }
  }

  // 3. referrals: on trade points earned from the binding on
  const bonusBlocks = inviteeBonusBlocks(input.blockSeconds);
  const byInvitee = new Map<string, Referral>();
  for (const r of input.referrals) byInvitee.set(r.invitee.toLowerCase(), r);
  for (const t of trades) {
    const r = byInvitee.get(t.wallet.toLowerCase());
    if (!r || t.block < r.block) continue;
    const m = milliOf.get(t) ?? 0n;
    const inv = (m * RULES.inviterPct) / 100n;
    if (inv > 0n) out.push({ wallet: low(r.inviter), kind: "ref_inviter", milli: inv, token: t.token, ref: refOf(t), block: t.block });
    if (t.block <= r.block + bonusBlocks) {
      const own = (m * RULES.inviteePct) / 100n;
      if (own > 0n) out.push({ wallet: low(t.wallet), kind: "ref_invitee", milli: own, token: t.token, ref: refOf(t), block: t.block });
    }
  }

  return out;
}

/** points per wallet */
export function totals(ledger: Iterable<LedgerEntry>): Map<`0x${string}`, bigint> {
  const m = new Map<`0x${string}`, bigint>();
  for (const e of ledger) m.set(e.wallet, (m.get(e.wallet) ?? 0n) + e.milli);
  return m;
}

/** wallets by points, highest first; equal points break on the address, so a rank never flickers */
export function ranking(t: Map<`0x${string}`, bigint>): { wallet: `0x${string}`; milli: bigint }[] {
  return [...t.entries()]
    .map(([wallet, milli]) => ({ wallet, milli }))
    .sort((a, b) => (a.milli === b.milli ? (a.wallet < b.wallet ? -1 : 1) : a.milli > b.milli ? -1 : 1));
}

function low(a: `0x${string}`): `0x${string}` {
  return a.toLowerCase() as `0x${string}`;
}
function refOf(t: Trade): string {
  return `${t.tx}:${t.logIndex}`;
}
