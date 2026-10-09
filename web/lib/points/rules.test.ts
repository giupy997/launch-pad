// The rules against made-up facts: the worked example of POINTS.md, and the
// edges (a season's bounds, a hidden coin, a binding that must not pay for
// the past, the first-buyers cap, a seller who left before the graduation).
//   node --test --experimental-strip-types web/lib/points/rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLedger, inviteeBonusBlocks, ranking, totals, tradeMilli, type Coin, type Referral, type Trade, inviterChainHas } from "./rules.ts";
import type { PointsSeason } from "./chains.ts";

const A = "0x000000000000000000000000000000000000000a" as const;
const B = "0x000000000000000000000000000000000000000b" as const;
const C = "0x000000000000000000000000000000000000000c" as const;
const D = "0x000000000000000000000000000000000000000d" as const;
const COIN = "0x00000000000000000000000000000000000c0001" as const;
const LTC = 10n ** 18n;
const season: PointsSeason = { number: 0, name: "Season 0", start: 100n, end: null, rehearsal: true };

let n = 0;
const trade = (wallet: Trade["wallet"], side: Trade["side"], ltc: number, block: bigint, token = COIN): Trade => ({
  tx: `0x${(++n).toString(16).padStart(64, "0")}`,
  logIndex: 0,
  block,
  token,
  wallet,
  side,
  quote: BigInt(Math.round(ltc * 1e6)) * (LTC / 10n ** 6n),
  tokens: BigInt(Math.round(ltc * 1e6)) * 10n ** 18n, // 1 coin per µLTC, the price does not matter here
});
const sum = (m: Map<string, bigint>, w: string) => m.get(w) ?? 0n;

test("20 points per LTC, in thousandths, on 18 and 8 decimals", () => {
  assert.equal(tradeMilli(LTC, 18), 20_000n);
  assert.equal(tradeMilli(LTC / 100n, 18), 200n); // 0.01 LTC: 0.2 points, not nothing
  assert.equal(tradeMilli(10n ** 8n, 8), 20_000n); // 1 cbLTC
  assert.equal(tradeMilli(3n * 10n ** 8n, 8), 60_000n);
});

test("the worked example of POINTS.md", () => {
  // A buys 2 LTC, sells 1; the coin graduates while A still holds; A was an early buyer; A came in through D's invite
  const trades = [trade(A, "buy", 2, 110n), trade(A, "sell", 1, 120n)];
  const coins: Coin[] = [{ token: COIN, creator: C, createdBlock: 105n, graduatedBlock: 130n }];
  const referrals: Referral[] = [{ invitee: A, inviter: D, block: 108n, ts: 0 }];
  const ledger = computeLedger({ trades, coins, referrals, season, quoteDecimals: 18, blockSeconds: 1, hidden: new Set() });
  const t = totals(ledger);
  // 60 trade + 30 holder + 100 early + 3 invitee = 193
  assert.equal(sum(t, A), 193_000n);
  // the inviter: 10% of A's 60
  assert.equal(sum(t, D), 6_000n);
  // the creator: 2,000
  assert.equal(sum(t, C), 2_000_000n);
});

test("a seller who left before the graduation gets no holder bonus, a dust holder keeps only what they paid for", () => {
  const trades = [
    trade(A, "buy", 1, 110n),
    trade(A, "sell", 1, 111n), // net zero
    trade(B, "buy", 1, 112n),
    trade(B, "sell", 0.999, 113n), // dust left
  ];
  const coins: Coin[] = [{ token: COIN, creator: C, createdBlock: 105n, graduatedBlock: 130n }];
  const ledger = computeLedger({ trades, coins, referrals: [], season, quoteDecimals: 18, blockSeconds: 1, hidden: new Set() });
  const holder = ledger.filter((e) => e.kind === "grad_holder");
  assert.deepEqual(
    holder.map((e) => [e.wallet, e.milli]),
    [[B, ((20_000n + 19_980n) * 50n) / 100n]]
  );
});

test("only the first 25 distinct buyers are early, counted once each", () => {
  const trades: Trade[] = [];
  for (let i = 0; i < 40; i++) {
    const w = `0x${(i + 1).toString(16).padStart(40, "0")}` as const;
    trades.push(trade(w, "buy", 0.1, 110n + BigInt(i)));
    trades.push(trade(w, "buy", 0.1, 150n + BigInt(i))); // a second buy must not count twice
  }
  const coins: Coin[] = [{ token: COIN, creator: C, createdBlock: 105n, graduatedBlock: 300n }];
  const ledger = computeLedger({ trades, coins, referrals: [], season, quoteDecimals: 18, blockSeconds: 1, hidden: new Set() });
  const early = ledger.filter((e) => e.kind === "early");
  assert.equal(early.length, 25);
  assert.equal(early[0].wallet, trades[0].wallet);
  assert.equal(early[24].wallet, trades[48].wallet);
});

test("a binding pays nothing for the past, and the invitee's bonus ends after 30 days", () => {
  const blockSeconds = 2;
  const bonus = inviteeBonusBlocks(blockSeconds);
  assert.equal(bonus, 1_296_000n);
  const bind = 1_000n;
  const trades = [
    trade(A, "buy", 1, 900n), // before the binding: nothing to either
    trade(A, "buy", 1, 1_000n), // at the binding: both
    trade(A, "buy", 1, bind + bonus), // last block of the bonus: both
    trade(A, "buy", 1, bind + bonus + 1n), // after: inviter only
  ];
  const referrals: Referral[] = [{ invitee: A, inviter: D, block: bind, ts: 0 }];
  const ledger = computeLedger({ trades, coins: [], referrals, season, quoteDecimals: 18, blockSeconds, hidden: new Set() });
  const inviter = ledger.filter((e) => e.kind === "ref_inviter").reduce((s, e) => s + e.milli, 0n);
  const invitee = ledger.filter((e) => e.kind === "ref_invitee").reduce((s, e) => s + e.milli, 0n);
  assert.equal(inviter, 3n * 2_000n);
  assert.equal(invitee, 2n * 1_000n);
});

test("a cycle of invitations pays nobody: two wallets that invited each other earn no inviter share", () => {
  const trades = [trade(A, "buy", 1, 200n), trade(D, "buy", 1, 201n)];
  // bound before the check at binding existed: the ledger alone must refuse it
  const referrals: Referral[] = [
    { invitee: A, inviter: D, block: 100n, ts: 0 },
    { invitee: D, inviter: A, block: 101n, ts: 0 },
  ];
  const ledger = computeLedger({ trades, coins: [], referrals, season, quoteDecimals: 18, blockSeconds: 1, hidden: new Set() });
  assert.equal(ledger.filter((e) => e.kind === "ref_inviter" || e.kind === "ref_invitee").length, 0);
  assert.equal(ledger.filter((e) => e.kind === "trade").length, 2);
  // and the walk itself: a chain that leads back is a cycle, one that ends is not
  const byInvitee = new Map(referrals.map((r) => [r.invitee.toLowerCase(), r]));
  assert.equal(inviterChainHas(byInvitee, D, A), true);
  assert.equal(inviterChainHas(new Map([[A.toLowerCase(), referrals[0]]]), D, A), false);
});

test("a season's bounds and a hidden coin cut trades out, graduations included", () => {
  const closed: PointsSeason = { ...season, end: 200n };
  const HIDDEN = "0x00000000000000000000000000000000000c0002" as const;
  const trades = [
    trade(A, "buy", 1, 99n), // before the season
    trade(A, "buy", 1, 150n),
    trade(A, "buy", 1, 201n), // after it
    trade(B, "buy", 5, 150n, HIDDEN),
  ];
  const coins: Coin[] = [
    { token: COIN, creator: C, createdBlock: 105n, graduatedBlock: 250n }, // graduates after the season: no bonuses
    { token: HIDDEN, creator: C, createdBlock: 105n, graduatedBlock: 160n },
  ];
  const ledger = computeLedger({ trades, coins, referrals: [], season: closed, quoteDecimals: 18, blockSeconds: 1, hidden: new Set([HIDDEN]) });
  const t = totals(ledger);
  assert.equal(sum(t, A), 20_000n);
  assert.equal(sum(t, B), 0n);
  assert.equal(sum(t, C), 0n);
});

test("the ranking breaks ties on the address and never flickers", () => {
  const t = new Map<`0x${string}`, bigint>([
    [B, 5n],
    [A, 5n],
    [C, 9n],
  ]);
  assert.deepEqual(
    ranking(t).map((r) => r.wallet),
    [C, A, B]
  );
});
