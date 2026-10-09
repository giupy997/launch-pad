// One chain's points, live: reads the pad's logs a stretch at a time, keeps
// the facts (trades, coins, bindings) in memory and on disk, and recomputes
// the ledger from them after every pass. Serves the leaderboard and a
// wallet's view from memory.

import { type PointsChain } from "./chains.ts";
import { decodePadLog, eventOrder, PAD_TOPICS, type PadEvent } from "./decode.ts";
import { verifyReferral } from "./referral.ts";
import {
  computeLedger,
  inviteeBonusBlocks,
  KIND_LABELS,
  milliToPoints,
  ranking,
  RULES,
  RULES_VERSION,
  totals,
  type Coin,
  type LedgerEntry,
  type LedgerKind,
  type Referral,
  type Trade,
  inviterChainHas,
} from "./rules.ts";
import { stretches, type Nodes } from "./scan.ts";
import type { Store } from "./store.ts";
import type { LeaderboardRow, SeasonView, WalletView } from "./types.ts";

export type IndexerOptions = {
  /** ranges per pass, so a backfill proceeds in passes while the API answers */
  maxChunksPerPass?: number;
  now?: () => number;
};

export class ChainIndexer {
  readonly chain: PointsChain;
  readonly nodes: Nodes;
  readonly store: Store;
  readonly trades: Trade[] = [];
  readonly coins = new Map<string, Coin>();
  readonly referrals = new Map<string, Referral>();
  /** the newest block fully indexed */
  last: bigint;
  head = 0n;
  /** a FreezeAnnounced on the pad: the season ends there */
  freezeBlock: bigint | null = null;
  ledger: LedgerEntry[] = [];
  totals = new Map<`0x${string}`, bigint>();
  ranks = new Map<`0x${string}`, number>();
  board: { wallet: `0x${string}`; milli: bigint }[] = [];
  lastError: string | null = null;
  updatedAt: number | null = null;
  passes = 0;
  private readonly maxChunksPerPass: number;
  private readonly now: () => number;
  private readonly hidden: Set<string>;

  constructor(chain: PointsChain, nodes: Nodes, store: Store, opts: IndexerOptions = {}) {
    this.chain = chain;
    this.nodes = nodes;
    this.store = store;
    this.maxChunksPerPass = opts.maxChunksPerPass ?? 40;
    this.now = opts.now ?? Date.now;
    this.hidden = new Set(chain.hidden.map((a) => a.toLowerCase()));
    const meta = store.readMeta();
    for (const ev of store.loadEvents()) this.apply(ev);
    for (const r of store.loadReferrals()) this.referrals.set(r.invitee.toLowerCase(), r);
    this.last = meta?.last ?? chain.deployBlock - 1n;
    this.recompute();
  }

  private apply(ev: PadEvent) {
    switch (ev.kind) {
      case "created":
        this.coins.set(ev.token, { token: ev.token, creator: ev.creator, createdBlock: ev.block, graduatedBlock: null });
        break;
      case "bought":
      case "sold":
        this.trades.push({
          tx: ev.tx,
          logIndex: ev.logIndex,
          block: ev.block,
          token: ev.token,
          wallet: ev.wallet,
          side: ev.kind === "bought" ? "buy" : "sell",
          quote: ev.quote,
          tokens: ev.tokens,
        });
        break;
      case "graduated": {
        const c = this.coins.get(ev.token);
        if (c) c.graduatedBlock = ev.block;
        else this.coins.set(ev.token, { token: ev.token, creator: "0x0000000000000000000000000000000000000000", createdBlock: ev.block, graduatedBlock: ev.block });
        break;
      }
      case "freeze":
        this.freezeBlock = ev.freezeBlock;
        break;
    }
  }

  /** the season as it stands: configured, closed early by a freeze */
  effectiveSeason() {
    const s = this.chain.season;
    if (!s) return null;
    const end = s.end ?? this.freezeBlock;
    return { ...s, end };
  }

  recompute() {
    const season = this.effectiveSeason();
    this.ledger = season
      ? computeLedger({
          trades: this.trades,
          coins: this.coins.values(),
          referrals: this.referrals.values(),
          season,
          quoteDecimals: this.chain.quoteDecimals,
          blockSeconds: this.chain.blockSeconds,
          hidden: this.hidden,
        })
      : [];
    this.totals = totals(this.ledger);
    this.board = ranking(this.totals);
    this.ranks = new Map(this.board.map((r, i) => [r.wallet, i + 1]));
  }

  /** read the blocks mined since the last pass (up to maxChunksPerPass ranges), keep what came back contiguous */
  async pass(): Promise<{ from: bigint; to: bigint; events: number } | null> {
    try {
      this.head = await this.nodes.blockNumber();
      const target = this.head - this.chain.lag;
      if (target <= this.last) {
        // nothing mined since (a quiet chain makes no blocks): a pass all the same
        this.lastError = null;
        this.passes++;
        this.updatedAt = Math.floor(this.now() / 1000);
        return null;
      }
      const from = this.last + 1n;
      const cap = from + this.nodes.chunk * BigInt(this.maxChunksPerPass) - 1n;
      const to = target < cap ? target : cap;
      const { logs, ok, failed } = await this.nodes.getLogs({ address: this.chain.pad, topics: [PAD_TOPICS] }, from, to);
      // only a stretch that starts where we left off counts; the rest is read again next pass
      const first = stretches(ok).find((s) => s.lo === from);
      if (!first) throw new Error(`no node served blocks ${from}…${to}` + (failed.length ? ` (${failed.length} ranges refused)` : ""));
      const upTo = first.hi;
      const events = logs
        .map(decodePadLog)
        .filter((e): e is PadEvent => e !== null && e.block >= from && e.block <= upTo)
        .sort(eventOrder);
      this.store.appendEvents(events);
      for (const ev of events) this.apply(ev);
      this.last = upTo;
      this.store.writeMeta({ last: upTo, rulesVersion: RULES_VERSION, chunk: this.nodes.chunk });
      this.recompute();
      this.passes++;
      this.updatedAt = Math.floor(this.now() / 1000);
      this.lastError = null;
      return { from, to: upTo, events: events.length };
    } catch (e) {
      this.lastError = (e as Error).message.split("\n")[0];
      throw e;
    }
  }

  season(): SeasonView {
    const s = this.effectiveSeason();
    let graduations = 0;
    for (const c of this.coins.values()) if (c.graduatedBlock !== null) graduations++;
    return {
      chain: this.chain.key,
      chainId: this.chain.chainId,
      name: this.chain.name,
      season: s ? { number: s.number, name: s.name, start: s.start.toString(), end: s.end === null ? null : s.end.toString(), rehearsal: s.rehearsal } : null,
      quoteSymbol: this.chain.quoteSymbol,
      rules: {
        version: RULES_VERSION,
        pointsPerQuote: Number(RULES.tradeMilliPerQuote) / 1000,
        holderBonusPct: Number(RULES.holderBonusPct),
        creatorGraduation: Number(RULES.creatorGraduationMilli) / 1000,
        earlyBuyers: RULES.earlyBuyers,
        earlyBuyer: Number(RULES.earlyBuyerMilli) / 1000,
        inviterPct: Number(RULES.inviterPct),
        inviteePct: Number(RULES.inviteePct),
        inviteeDays: RULES.inviteeDays,
      },
      indexed: {
        last: this.last.toString(),
        head: this.head.toString(),
        lagBlocks: Number(this.chain.lag),
        trades: this.trades.length,
        coins: this.coins.size,
        graduations,
        wallets: this.totals.size,
        referrals: this.referrals.size,
      },
      updatedAt: this.updatedAt,
      lastError: this.lastError,
    };
  }

  private tradeStats(wallet: string): { trades: number; volume: bigint } {
    let trades = 0;
    let volume = 0n;
    const season = this.effectiveSeason();
    for (const t of this.trades) {
      if (t.wallet !== wallet) continue;
      if (season && (t.block < season.start || (season.end !== null && t.block > season.end))) continue;
      if (this.hidden.has(t.token)) continue;
      trades++;
      volume += t.quote;
    }
    return { trades, volume };
  }

  private inviteesOf(wallet: string): { wallet: `0x${string}`; points: number }[] {
    const brought = new Map<`0x${string}`, bigint>();
    for (const r of this.referrals.values()) if (r.inviter.toLowerCase() === wallet) brought.set(r.invitee.toLowerCase() as `0x${string}`, 0n);
    for (const e of this.ledger) if (e.kind === "ref_inviter" && e.wallet === wallet && e.ref) {
      // the invitee is the trader of the referenced trade
      const t = this.tradeByRef(e.ref);
      if (t) brought.set(t.wallet, (brought.get(t.wallet) ?? 0n) + e.milli);
    }
    return [...brought.entries()].map(([w, m]) => ({ wallet: w, points: milliToPoints(m) })).sort((a, b) => b.points - a.points);
  }

  private refIndex: Map<string, Trade> | null = null;
  private refIndexSize = -1;
  private tradeByRef(ref: string): Trade | undefined {
    if (!this.refIndex || this.refIndexSize !== this.trades.length) {
      this.refIndex = new Map(this.trades.map((t) => [`${t.tx}:${t.logIndex}`, t]));
      this.refIndexSize = this.trades.length;
    }
    return this.refIndex.get(ref);
  }

  leaderboard(limit = 100): LeaderboardRow[] {
    const inviteeCount = new Map<string, number>();
    for (const r of this.referrals.values()) {
      const k = r.inviter.toLowerCase();
      inviteeCount.set(k, (inviteeCount.get(k) ?? 0) + 1);
    }
    return this.board.slice(0, Math.max(1, Math.min(limit, 500))).map((r, i) => {
      const s = this.tradeStats(r.wallet);
      return { rank: i + 1, wallet: r.wallet, points: milliToPoints(r.milli), trades: s.trades, volume: s.volume.toString(), invitees: inviteeCount.get(r.wallet) ?? 0 };
    });
  }

  wallet(address: string): WalletView {
    const w = address.toLowerCase() as `0x${string}`;
    const byKind = new Map<LedgerKind, bigint>();
    for (const e of this.ledger) if (e.wallet === w) byKind.set(e.kind, (byKind.get(e.kind) ?? 0n) + e.milli);
    const s = this.tradeStats(w);
    const binding = this.referrals.get(w) ?? null;
    return {
      wallet: w,
      rank: this.ranks.get(w) ?? null,
      points: milliToPoints(this.totals.get(w) ?? 0n),
      byKind: (Object.keys(KIND_LABELS) as LedgerKind[])
        .filter((k) => byKind.has(k))
        .map((k) => ({ kind: k, label: KIND_LABELS[k], points: milliToPoints(byKind.get(k)!) })),
      trades: s.trades,
      volume: s.volume.toString(),
      inviter: binding ? (binding.inviter.toLowerCase() as `0x${string}`) : null,
      invitees: this.inviteesOf(w),
      inviteeBonusUntil: binding ? (binding.block + inviteeBonusBlocks(this.chain.blockSeconds)).toString() : null,
    };
  }

  /** accept an invite: verified, one per wallet, never itself, never a cycle */
  async bindReferral(claim: { invitee: string; inviter: string; signature: string }): Promise<{ status: number; body: Record<string, unknown> }> {
    const season = this.effectiveSeason();
    if (!season) return { status: 404, body: { error: "no season on this chain" } };
    const v = await verifyReferral({ ...claim, chainKey: this.chain.key, seasonNumber: season.number });
    if (!v.ok) return { status: 400, body: { error: v.reason } };
    const invitee = claim.invitee.toLowerCase() as `0x${string}`;
    const inviter = claim.inviter.toLowerCase() as `0x${string}`;
    const existing = this.referrals.get(invitee);
    if (existing) return { status: 409, body: { error: "already invited", inviter: existing.inviter } };
    // no cycle: the inviter's own chain of inviters must not lead back to the invitee, or two
    // wallets would pay each other a share of every trade for good
    if (inviterChainHas(this.referrals, inviter, invitee)) return { status: 409, body: { error: "that wallet was invited by you, or by someone you invited" } };
    const r: Referral = { invitee, inviter, block: this.head > 0n ? this.head : this.last, ts: Math.floor(this.now() / 1000) };
    this.store.appendReferral(r);
    this.referrals.set(invitee, r);
    this.recompute();
    return { status: 201, body: { ok: true, invitee: r.invitee, inviter: r.inviter, block: r.block.toString() } };
  }
}
