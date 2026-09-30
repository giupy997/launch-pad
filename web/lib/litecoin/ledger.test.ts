// Run with: node --test web/lib/litecoin/ledger.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { walletFromSecret } from "./tx.ts";
import {
  CURVE_SUPPLY,
  MEMO_MAX_BYTES,
  PARAMS,
  TOTAL_SUPPLY,
  claimableLit,
  heldSupply,
  liabilitiesLit,
  memo,
  memoBytes,
  replay,
  snapshot,
  spotPrice,
  virtualLitAt,
  rulesV2,
  type TxEvent,
  normalizeLink,
  parseLinks,
  stateRoot,
} from "./ledger.ts";

const LTC = 100_000_000n;
const DESK = "tltc1qdesk000000000000000000000000000000000";
const ALICE = "tltc1qalice0000000000000000000000000000000";
const BOB = "tltc1qbob0000000000000000000000000000000000";
const CAROL = "tltc1qcarol0000000000000000000000000000000";
const MALLORY = "tltc1qmallory000000000000000000000000000000";
const COLD = "mColdStorageAddress0000000000000000";
const CARRY = 10_000n;

let seq = 0;
/** A transaction from `sender` paying the desk `valueLit`, carrying `memoText`
 *  and, optionally, extra outputs (pointer targets start at index 2). */
function ev(sender: string | null, memoText: string | null, valueLit: bigint, extra: { address: string; lit: bigint }[] = [], opts: Partial<TxEvent> = {}): TxEvent {
  seq++;
  return {
    height: 1000 + seq, txIndex: 0, txid: seq.toString(16).padStart(64, "0"), time: 1_700_000_000 + seq * 150,
    sender, valueLit, memo: memoText, fromDesk: false,
    outputs: [
      { address: DESK, lit: valueLit, toDesk: true },
      { address: null, lit: 0n, toDesk: false },
      ...extra.map((x) => ({ ...x, toDesk: false })),
    ],
    ...opts,
  };
}

/** The desk paying `payouts`, with the `paid` memo for `ids`. */
function deskPays(payouts: { to: string; lit: bigint }[], ids: (number | string)[], opts: Partial<TxEvent> = {}): TxEvent {
  seq++;
  return {
    height: 1000 + seq, txIndex: 0, txid: seq.toString(16).padStart(64, "0"), time: 1_700_000_000 + seq * 150,
    sender: DESK, valueLit: 0n, memo: memo.paid(ids.map(String)), fromDesk: true,
    outputs: [
      ...payouts.map((p) => ({ address: p.to, lit: p.lit, toDesk: false })),
      { address: null, lit: 0n, toDesk: false },
      { address: DESK, lit: 5n * LTC, toDesk: true },
    ],
    ...opts,
  };
}

/** received − paid out must cover everything owed plus the treasury. */
function assertSolvent(events: TxEvent[]) {
  const s = replay("test", events);
  let inflow = 0n;
  const seen = new Set<string>();
  for (const e of events) if (!e.fromDesk && !seen.has(e.txid) && seen.add(e.txid)) inflow += e.valueLit;
  let paid = 0n;
  for (const p of s.payouts) if (p.paidTxid) paid += p.lit;
  const owed = liabilitiesLit(s) + s.treasuryLit;
  assert.ok(inflow - paid >= owed, `insolvent: holds ${inflow - paid}, owes ${owed}`);
  assert.ok(inflow - paid - owed < 10_000n, "no more than rounding dust unaccounted for");
  return s;
}

test("deploy, buy, price rises, creator-mode fee split", () => {
  const events = [
    ev(ALICE, memo.deploy("CAT", "Lite Cat", false), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("CAT"), LTC / 10n),
  ];
  const s = assertSolvent(events);
  const coin = s.coins.get("CAT")!;
  assert.equal(coin.name, "Lite Cat");
  assert.equal(coin.creator, ALICE);
  assert.ok(s.balances.get("CAT")!.get(BOB)! > 0n);
  assert.ok(spotPrice(coin) > Number(PARAMS.test.virtualLit) / 1.05e17, "price moved up from the opening price");
  // 1% fee = 100_000 lit: 80% creator credit, 20% (+ deploy fee) treasury
  assert.equal(claimableLit(s, ALICE), 80_000n);
  assert.equal(s.treasuryLit, 20_000n + PARAMS.test.deployFeeLit);
  assert.equal(claimableLit(s, BOB), 0n);
});

test("holders mode: cashback pro-rata; claim becomes a payout only the desk can settle", () => {
  const events = [
    ev(ALICE, memo.deploy("RWD", "Rewards", true), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("RWD"), LTC / 10n),
    ev(CAROL, memo.buy("RWD"), LTC / 5n),
  ];
  let s = assertSolvent(events);
  assert.equal(claimableLit(s, ALICE), 0n, "nothing to the creator in holders mode");
  const bobCb = claimableLit(s, BOB), carolCb = claimableLit(s, CAROL);
  assert.ok(bobCb > carolCb && carolCb > PARAMS.test.minPayoutLit, "bob earned on both buys, carol on hers");
  assert.ok(240_000n - (bobCb + carolCb) < 10n, "80% of both fees reaches the holders");

  events.push(ev(BOB, memo.claim(), CARRY));
  s = assertSolvent(events);
  assert.equal(s.payouts.length, 1);
  assert.equal(s.payouts[0].to, BOB, "paid back where it came from");
  assert.equal(s.payouts[0].lit, bobCb + CARRY, "cashback plus the dust that carried the claim");
  assert.equal(claimableLit(s, BOB), 0n);

  // carol claims to a cold address: output 2 of her own transaction
  events.push(ev(CAROL, memo.claim(2), CARRY, [{ address: COLD, lit: 6_000n }]));
  s = assertSolvent(events);
  assert.equal(s.payouts[1].to, COLD);
  const due = s.payouts.map((p) => p.lit);

  // a user cannot settle payouts; the desk cannot settle by underpaying
  events.push(ev(MALLORY, memo.paid(["0"]), CARRY));
  s = replay("test", events);
  assert.equal(s.payouts[0].paidTxid, null);
  assert.match(s.rejected.at(-1)!.reason, /only the desk/);
  events.push(deskPays([{ to: BOB, lit: due[0] - 1n }], [0]));
  s = replay("test", events);
  assert.equal(s.payouts[0].paidTxid, null);
  assert.match(s.rejected.at(-1)!.reason, /no output pays it in full/);
  // one desk transaction settles both, each with its own output
  const settle = deskPays([{ to: BOB, lit: due[0] }, { to: COLD, lit: due[1] }], [0, 1]);
  events.push(settle);
  s = assertSolvent(events);
  assert.equal(s.payouts[0].paidTxid, settle.txid);
  assert.equal(s.payouts[1].paidTxid, settle.txid);
  // paying the same ids again does nothing
  events.push(deskPays([{ to: BOB, lit: due[0] }, { to: COLD, lit: due[1] }], [0, 1]));
  assert.match(replay("test", events).rejected.at(-1)!.reason, /already paid/);
});

test("sell: only the funding address spends a balance; payout pointers; no replays", () => {
  const base = [
    ev(ALICE, memo.deploy("DOG", "Dog", false), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("DOG"), LTC / 5n),
  ];
  const bal = replay("test", base).balances.get("DOG")!.get(BOB)!;

  // mallory cannot sell bob's coins: the chain says she funded the transaction
  let s = replay("test", [...base, ev(MALLORY, memo.sell("DOG", bal, 0n), CARRY)]);
  assert.equal(s.payouts.length, 0);
  assert.equal(s.rejected.at(-1)!.reason, "insufficient balance");

  const good = ev(BOB, memo.sell("DOG", bal / 2n, 0n), CARRY);
  const events = [...base, good];
  s = assertSolvent(events);
  assert.equal(s.payouts.length, 1);
  assert.equal(s.payouts[0].to, BOB);
  assert.equal(s.balances.get("DOG")!.get(BOB), bal - bal / 2n);
  assert.equal(claimableLit(s, BOB), CARRY, "the carried dust is refundable");

  // the very same transaction seen twice is one transaction
  s = assertSolvent([...events, { ...good }]);
  assert.equal(s.payouts.length, 1);
  assert.equal(s.txsRead, 3);

  // payout to a pointed output; pointing at the desk or the memo is refused
  events.push(ev(BOB, memo.sell("DOG", bal / 8n, 0n, 2), CARRY, [{ address: COLD, lit: 6_000n }]));
  s = assertSolvent(events);
  assert.equal(s.payouts.at(-1)!.to, COLD);
  events.push(ev(BOB, memo.sell("DOG", bal / 8n, 0n, 0), CARRY));
  assert.equal(assertSolvent(events).rejected.at(-1)!.reason, "bad payout output");
  events.push(ev(BOB, memo.sell("DOG", bal / 8n, 0n, 1), CARRY));
  assert.equal(assertSolvent(events).rejected.at(-1)!.reason, "bad payout output");

  // slippage guard and over-selling
  events.push(ev(BOB, memo.sell("DOG", bal / 8n, 10n * LTC), CARRY));
  assert.equal(assertSolvent(events).rejected.at(-1)!.reason, "slippage");
  events.push(ev(BOB, memo.sell("DOG", bal, 0n), CARRY));
  assert.equal(assertSolvent(events).rejected.at(-1)!.reason, "insufficient balance");
});

test("send moves coins to a pointed output; self-send cannot mint cashback", () => {
  const events = [
    ev(ALICE, memo.deploy("SND", "Send", true), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("SND"), LTC / 5n),
    ev(CAROL, memo.buy("SND"), LTC / 5n),
  ];
  const before = replay("test", events);
  const bal = before.balances.get("SND")!.get(BOB)!;
  const honest = claimableLit(before, BOB);

  for (let n = 0; n < 10; n++) events.push(ev(BOB, memo.send("SND", bal, 2), CARRY, [{ address: BOB, lit: 6_000n }]));
  let s = assertSolvent(events);
  assert.equal(claimableLit(s, BOB) - honest, 10n * CARRY, "only the carried dust was credited");

  events.push(ev(BOB, memo.send("SND", bal / 4n, 2), CARRY, [{ address: CAROL, lit: 6_000n }]));
  s = assertSolvent(events);
  assert.equal(s.balances.get("SND")!.get(BOB), bal - bal / 4n);
  const carol = s.balances.get("SND")!.get(CAROL)!;

  // pointing at the memo output, the desk, or past the end does nothing
  for (const o of [1, 0, 7]) events.push(ev(BOB, memo.send("SND", bal / 8n, o), CARRY, [{ address: CAROL, lit: 6_000n }]));
  s = assertSolvent(events);
  assert.equal(s.balances.get("SND")!.get(CAROL), carol);
  assert.equal(s.rejected.at(-1)!.reason, "bad recipient output");
});

test("graduation: at 800M the raised LTC and the 200M reserve become a locked pool — no ceiling, always liquid", () => {
  const events = [
    ev(ALICE, memo.deploy("TOP", "Top", true), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("TOP"), 5n * LTC), // the curve only needs ~0.65 LTC
  ];
  let s = assertSolvent(events);
  const coin = s.coins.get("TOP")!;
  assert.equal(coin.sold, CURVE_SUPPLY);
  assert.equal(coin.graduated, true);
  assert.equal(coin.poolToken, TOTAL_SUPPLY - CURVE_SUPPLY, "the 200M reserve seeds the pool");
  assert.equal(coin.poolLit, coin.realLit, "with every LTC the curve raised");
  assert.ok(claimableLit(s, BOB) > 4n * LTC, "the surplus over the curve stays the buyer's");
  // pump.fun-style hand-over: the pool opens a few percent under the curve's last price
  const lastCurvePrice = Number(coin.vLit) / Number(coin.vToken);
  const openPrice = spotPrice(coin);
  assert.ok(openPrice < lastCurvePrice && openPrice > lastCurvePrice * 0.94, `pool opens at ${openPrice / lastCurvePrice} of the curve price`);

  // buys keep working through the pool and the price keeps rising: no ceiling
  events.push(ev(CAROL, memo.buy("TOP"), LTC));
  s = assertSolvent(events);
  const c2 = s.coins.get("TOP")!;
  assert.ok(s.balances.get("TOP")!.get(CAROL)! > 0n && c2.poolToken < TOTAL_SUPPLY - CURVE_SUPPLY);
  assert.ok(spotPrice(c2) > openPrice);
  events.push(ev(CAROL, memo.buy("TOP"), 100n * LTC));
  s = assertSolvent(events);
  const c3 = s.coins.get("TOP")!;
  assert.ok(spotPrice(c3) > spotPrice(c2) * 50, "a whale moves the price a lot, never into a wall");
  assert.ok(c3.poolToken > 0n, "the last token is never for sale");
  assert.equal(c3.sold, CURVE_SUPPLY, "the curve figures stay frozen at graduation");

  // sells always fill from the pool; holders mode keeps paying, spread over the coins people hold
  const bobBal = s.balances.get("TOP")!.get(BOB)!;
  events.push(ev(BOB, memo.sell("TOP", bobBal / 2n, 0n), CARRY));
  s = assertSolvent(events);
  const c4 = s.coins.get("TOP")!;
  assert.ok(s.payouts.at(-1)!.lit > 0n && s.payouts.at(-1)!.holder === BOB);
  assert.equal(c4.poolToken, c3.poolToken + bobBal / 2n);
  assert.equal(heldSupply(c4), TOTAL_SUPPLY - c4.poolToken);
  assert.ok(claimableLit(s, CAROL) > 0n, "carol earned cashback on bob's sell");
  assert.ok(spotPrice(c4) < spotPrice(c3));
});

test("first paid deploy wins the ticker; whatever else arrives is refundable", () => {
  const events = [
    ev(ALICE, memo.deploy("ONE", "First", false), PARAMS.test.deployFeeLit),
    ev(BOB, memo.deploy("ONE", "Second", true), PARAMS.test.deployFeeLit + 5_000n),
    ev(CAROL, null, 12_345n), // plain LTC sent to the desk, no memo at all
    ev(CAROL, "hello there", 1_000n),
    ev(CAROL, "NOTUS1 deploy x", 1n),
    ev(CAROL, "NOTUS1 buy ONE " + "9".repeat(70), 2_000n), // 86 bytes: cannot be relayed, so nobody folds it in
    ev(BOB, memo.deploy("CHEAP", "Underpaid", false), PARAMS.test.deployFeeLit - 1n),
    ev(null, memo.buy("ONE"), 7_777n), // funded by a non-standard script: nobody to credit
  ];
  const s = assertSolvent(events);
  assert.equal(s.coins.get("ONE")!.name, "First");
  assert.equal(claimableLit(s, BOB), PARAMS.test.deployFeeLit + 5_000n + PARAMS.test.deployFeeLit - 1n, "late and underpaid deploys are refundable");
  assert.equal(claimableLit(s, CAROL), 12_345n + 1_000n + 1n + 2_000n, "everything sent to the desk stays claimable");
  assert.equal(s.coins.has("CHEAP"), false);
  assert.equal(s.treasuryLit, PARAMS.test.deployFeeLit + 7_777n);
  assert.equal(s.rejected.length, 7);
  assert.equal(s.rejected[0].reason, "ticker taken — credited");
  assert.equal(s.rejected[1].reason, "no memo — credited");
  assert.equal(s.rejected[4].reason, "memo over 80 bytes — credited");
  assert.equal(s.rejected.at(-1)!.reason, "no recognisable sender");
});

test("fund: LTC for the desk's fees goes to the treasury, owed to nobody", () => {
  const events = [
    ev(ALICE, memo.fund(), 1_000_000n),
    ev(BOB, null, 1_000_000n), // a faucet or a wallet without memos: credited, claimable
    ev(CAROL, memo.fund(), 0n),
  ];
  const s = assertSolvent(events);
  assert.equal(s.treasuryLit, 1_000_000n);
  assert.equal(claimableLit(s, ALICE), 0n);
  assert.equal(claimableLit(s, BOB), 1_000_000n);
  assert.equal(s.rejected.length, 2);
  assert.equal(s.rejected.at(-1)!.reason, "no LTC attached");
  // still allowed after a freeze: the desk keeps paying out
  const frozen = replay("test", [...events, { ...ev(ALICE, memo.fund(), 5_000n), height: 9_000 }], { ...PARAMS.test, freezeHeight: 8_000 });
  assert.equal(frozen.treasuryLit, 1_005_000n);
});

test("sweep: the desk moves treasury to cold storage; rules v2 only, never more than the treasury", () => {
  const funded = [ev(ALICE, memo.fund(), 3_000_000n), ev(BOB, null, 1_000_000n)];
  /** The desk sending `lit` to cold storage with the sweep memo. */
  const sweep = (lit: bigint, height: number): TxEvent => ({
    ...deskPays([{ to: COLD, lit }], []),
    memo: memo.sweep(),
    height,
  });
  const v2 = { ...PARAMS.test, rulesV2From: 2_000 };
  // before rules v2: a desk transaction without a payout memo, as ever
  const before = replay("test", [...funded, sweep(1_000_000n, 1_500)], v2);
  assert.equal(before.treasuryLit, 3_000_000n);
  assert.equal(before.rejected.at(-1)!.reason, "desk transaction without a payout memo");
  // under rules v2: the treasury shrinks by what left the desk; what is owed (Bob's credit) is untouched
  const after = replay("test", [...funded, sweep(1_000_000n, 2_500)], v2);
  assert.equal(after.treasuryLit, 2_000_000n);
  assert.equal(claimableLit(after, BOB), 1_000_000n);
  assert.equal(after.rejected.length, before.rejected.length - 1);
  // more than the treasury: clamped, the ledger never records a negative treasury
  const over = replay("test", [...funded, sweep(9_000_000n, 2_500)], v2);
  assert.equal(over.treasuryLit, 0n);
  assert.notEqual(stateRoot(before), stateRoot(after), "a sweep is part of the state");
});

test("logo: set at deploy when it fits, changed later only by the creator", () => {
  const events = [
    ev(ALICE, memo.deploy("PIC", "Picture", false, "https://i.example/p.png"), PARAMS.test.deployFeeLit),
    ev(BOB, memo.logo("PIC", "https://evil.example/x.png"), CARRY),
    ev(ALICE, memo.logo("PIC", "javascript:alert(1)"), CARRY),
    ev(ALICE, memo.logo("PIC", "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"), CARRY), // 82 bytes
    ev(ALICE, memo.logo("PIC", "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"), CARRY),
  ];
  const s = assertSolvent(events);
  assert.equal(s.coins.get("PIC")!.logo, "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
  assert.equal(s.rejected.map((r) => r.reason).join("|"), "only the creator sets the logo|bad logo|memo over 80 bytes — credited");
  assert.equal(claimableLit(s, BOB), CARRY);
});

test("deterministic: input order does not matter, roots match", () => {
  const events = [
    ev(ALICE, memo.deploy("DET", "Det", true), PARAMS.test.deployFeeLit + 50_000n),
    ev(BOB, memo.buy("DET"), LTC / 7n),
    ev(ALICE, memo.buy("DET"), LTC / 9n),
  ];
  const a = replay("test", events), b = replay("test", [...events].reverse());
  assert.equal(a.roots.at(-1)!.root, b.roots.at(-1)!.root);
  assert.equal(a.roots.length, 3);
  // two buys in one block are applied in block order, not by txid
  const twin = [events[0], { ...events[1], height: 5000, txIndex: 9, txid: "0".repeat(63) + "a" }, { ...events[2], height: 5000, txIndex: 3, txid: "f".repeat(64) }];
  const s = replay("test", twin);
  assert.equal(s.trades[0].holder, ALICE, "txIndex 3 comes before txIndex 9");
});

test("every instruction fits in 80 bytes at its longest", () => {
  const amount = CURVE_SUPPLY; // 18 digits
  const cases = [
    memo.deploy("ABCDEFGH", "Thirty two characters long name!", true),
    memo.deploy("ABCDEFGH", "Short", false, "https://i.example/logos/ltc-cat.png"),
    memo.logo("ABCDEFGH", "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"),
    memo.buy("ABCDEFGH", amount),
    memo.sell("ABCDEFGH", amount, 21_000_000n * LTC, 9),
    memo.send("ABCDEFGH", amount, 9),
    memo.claim(9),
    memo.fund(),
    memo.paid([9999, 9998, 9997, 9996, 9995, 9994, 9993, 9992, 9991, 9990]),
  ];
  for (const m of cases) assert.ok(memoBytes(m) <= MEMO_MAX_BYTES, `${m} is ${memoBytes(m)} bytes`);
  // a name with spaces is URL-encoded (3 bytes a space): a long one leaves no room for a logo in the same memo,
  // which is what the separate `logo` instruction is for
  assert.ok(memoBytes(memo.deploy("ABCDEFGH", "a name with lots of spaces in it", true)) <= MEMO_MAX_BYTES);
  assert.ok(memoBytes(memo.deploy("ABCDEFGH", "a name with lots of spaces in it", true, "https://i.example/logo.png")) > MEMO_MAX_BYTES);
});

test("freeze: after the height only claims and desk payouts work; everything else is refundable", () => {
  const live = [
    ev(ALICE, memo.deploy("FRZ", "Frozen", false), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("FRZ"), LTC / 10n),
  ];
  const freezeHeight = live[1].height;
  const after = [
    ev(CAROL, memo.buy("FRZ"), LTC / 10n),
    ev(BOB, memo.sell("FRZ", 1n, 0n), CARRY),
    ev(ALICE, memo.logo("FRZ", "https://x.example/l.png"), CARRY),
    ev(ALICE, memo.claim(), CARRY), // creator fees earned before the freeze
  ];
  const params = { ...PARAMS.test, freezeHeight };
  const s = replay("test", [...live, ...after], params);
  assert.equal(s.freezeHeight, freezeHeight);
  assert.equal(s.coins.get("FRZ")!.holders === undefined, true);
  assert.equal(s.balances.get("FRZ")!.get(CAROL), undefined, "no buy after the freeze");
  assert.equal(claimableLit(s, CAROL), LTC / 10n, "her LTC is credited back");
  assert.equal(s.rejected.filter((r) => r.reason === "ledger frozen for migration — credited").length, 3);
  assert.equal(s.payouts.length, 1, "the claim went through");
  assert.equal(s.payouts[0].holder, ALICE);
  // the desk can still settle it
  const settle = deskPays([{ to: ALICE, lit: s.payouts[0].lit }], [0]);
  assert.ok(replay("test", [...live, ...after, settle], params).payouts[0].paidTxid);
  // the frozen state is what the chain still says without the freeze, minus the late transactions
  assert.equal(replay("test", live).roots.at(-1)!.root, replay("test", live, params).roots.at(-1)!.root);
});

test("public keys: recorded from every signed transaction, ready for the EVM side", () => {
  const events = [
    ev(ALICE, memo.deploy("PUB", "Pub", false), PARAMS.test.deployFeeLit, [], { senderPubkey: "02" + "ab".repeat(32) }),
    ev(BOB, memo.buy("PUB"), LTC / 10n, [], { senderPubkey: "03" + "cd".repeat(32) }),
    ev(BOB, "garbage", 1_000n, [], { senderPubkey: "03" + "cd".repeat(32) }),
    ev(CAROL, memo.buy("PUB"), LTC / 10n), // an explorer that gave no witness
  ];
  const s = replay("test", events);
  assert.deepEqual([...s.pubkeys.entries()], [[ALICE, "02" + "ab".repeat(32)], [BOB, "03" + "cd".repeat(32)]]);
  assert.deepEqual(Object.keys(snapshot(s).pubkeys), [ALICE, BOB].sort());
  // chain data, not ownership: the root does not depend on it
  const bare = events.map((e) => ({ ...e, senderPubkey: null }));
  assert.equal(replay("test", bare).roots.at(-1)!.root, s.roots.at(-1)!.root);
});

test("fuzz: solvent after every transaction", () => {
  let rnd = 0xc0ffee;
  const next = (n: number) => ((rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) % n);
  const who = [ALICE, BOB, CAROL, MALLORY, COLD];
  const events = [
    ev(ALICE, memo.deploy("FZA", "Fuzz A", true), PARAMS.test.deployFeeLit),
    ev(BOB, memo.deploy("FZB", "Fuzz B", false), PARAMS.test.deployFeeLit + 1_000_000n),
  ];
  for (let i = 0; i < 300; i++) {
    const k = who[next(5)], ticker = next(2) ? "FZA" : "FZB";
    const s = replay("test", events);
    const bal = s.balances.get(ticker)?.get(k) ?? 0n;
    const op = next(6);
    if (op <= 1) events.push(ev(k, memo.buy(ticker), BigInt(1 + next(40_000_000))));
    else if (op === 2 && bal > 0n) events.push(ev(k, memo.sell(ticker, (bal * BigInt(1 + next(100))) / 100n, 0n), CARRY));
    else if (op === 3 && bal > 0n) events.push(ev(k, memo.send(ticker, (bal * BigInt(1 + next(100))) / 100n, 2), CARRY, [{ address: who[next(5)], lit: 6_000n }]));
    else if (op === 4) {
      const due = s.payouts.filter((p) => !p.paidTxid).slice(0, 3);
      if (due.length) events.push(deskPays(due.map((p) => ({ to: p.to, lit: p.lit })), due.map((p) => p.id)));
    } else events.push(ev(k, memo.claim(), CARRY));
    if (i % 10 === 0) assertSolvent(events);
  }
  const s = assertSolvent(events);
  assert.ok(s.trades.length > 50 && s.payouts.length > 5, "the fuzz actually traded and paid out");
  assert.ok(s.payouts.some((p) => p.paidTxid), "and the desk settled some");
});

test("a rule change only ever applies to coins deployed from its block on", () => {
  const p = { ...PARAMS.test, virtualLitChanges: [{ fromHeight: 1_000, virtualLit: 60_000_000n }] };
  assert.equal(virtualLitAt(p, 999), 20_000_000n);
  assert.equal(virtualLitAt(p, 1_000), 60_000_000n);
  assert.equal(virtualLitAt(PARAMS.test, 5_000_000), 20_000_000n, "no changes: the base reserve");
  // mainnet: the first coins keep 10 LTC, later ones open with 30
  assert.equal(virtualLitAt(PARAMS.main, 3_185_405), 1_000_000_000n);
  assert.equal(virtualLitAt(PARAMS.main, 3_185_910), 3_000_000_000n);
});

test("retireEmptyCoinsAt: coins nobody holds any more make room at that block, nothing else moves", () => {
  const p = { ...PARAMS.test, retireEmptyCoinsAt: 5_000, virtualLitChanges: [{ fromHeight: 5_000, virtualLit: 60_000_000n }] };
  const fee = PARAMS.test.deployFeeLit;
  const events: TxEvent[] = [
    ev(ALICE, memo.deploy("CAT", "Cat", true), fee, [], { height: 1_001 }), // holders mode, sold back to empty below
    ev(ALICE, memo.deploy("DOG", "Dog", false), fee, [], { height: 1_002 }), // stays held
    ev(ALICE, memo.deploy("EMPTY", "Empty", false), fee, [], { height: 1_003 }), // never bought
    ev(BOB, memo.buy("CAT"), 5_000_000n, [], { height: 1_010 }),
    ev(CAROL, memo.buy("CAT"), 5_000_000n, [], { height: 1_011 }), // carol's fee is bob's cashback
    ev(BOB, memo.buy("DOG"), 5_000_000n, [], { height: 1_012 }),
  ];
  let s = replay("test", events, p);
  const catBob = s.balances.get("CAT")!.get(BOB)!;
  const catCarol = s.balances.get("CAT")!.get(CAROL)!;
  events.push(ev(BOB, memo.sell("CAT", catBob, 0n), CARRY, [], { height: 1_020 }));
  events.push(ev(CAROL, memo.sell("CAT", catCarol, 0n), CARRY, [], { height: 1_021 }));
  s = replay("test", events, p);
  assert.equal(s.coins.get("CAT")!.sold, 0n, "CAT is empty");
  const owedBob = claimableLit(s, BOB);
  assert.ok(owedBob > 0n, "bob has unclaimed cashback from carol's buy");
  const treasuryBefore = s.treasuryLit;
  const dust = s.coins.get("CAT")!.realLit + s.coins.get("EMPTY")!.realLit;

  // the block has not come: nothing happens, even when the caller says the chain is at 4,999
  s = replay("test", events, p, 4_999);
  assert.deepEqual([...s.coins.keys()], ["CAT", "DOG", "EMPTY"]);
  assert.equal(s.retiredAt, null);

  // the chain reaches the block with no transaction to the desk: the rule still fires
  s = replay("test", events, p, 5_000);
  assert.deepEqual([...s.coins.keys()], ["DOG"], "CAT and EMPTY retired, DOG kept (bob holds it)");
  assert.equal(s.retiredAt, 5_000);
  assert.equal(claimableLit(s, BOB), owedBob, "cashback owed on a retired coin is still claimable");
  assert.equal(s.treasuryLit, treasuryBefore + dust, "the dust left in the emptied curves went to the treasury");
  assert.equal(s.roots.at(-1)!.height, 5_000, "the retirement is a root of its own");
  assert.equal(liabilitiesLit(s) <= 20_000_000n, true);

  // the tickers are free again, and a redeploy opens under the new rules
  events.push(ev(ALICE, memo.deploy("CAT", "Cat", true), fee, [], { height: 5_100 }));
  events.push(ev(ALICE, memo.deploy("LATE", "Late", false), fee, [], { height: 5_101 })); // empty, but born after the block
  s = replay("test", events, p, 6_000);
  assert.equal(s.coins.get("CAT")!.vLit, 60_000_000n, "the new CAT opens with the new reserve");
  assert.equal(s.coins.get("CAT")!.createdHeight, 5_100);
  assert.deepEqual([...s.coins.keys()].sort(), ["CAT", "DOG", "LATE"], "a coin born after the block is never retired");
  assert.equal(s.rejected.filter((r) => r.reason === "ticker taken").length, 0);
  // and the rule fires once: an old coin that empties later stays
  const dogBob = s.balances.get("DOG")!.get(BOB)!;
  events.push(ev(BOB, memo.sell("DOG", dogBob, 0n), CARRY, [], { height: 6_500 }));
  s = replay("test", events, p, 7_000);
  assert.equal(s.coins.get("DOG")!.sold, 0n);
  assert.ok(s.coins.has("DOG"), "emptied after the block: kept");
});

test("links: the creator sets X, Telegram and website; handles are normalised, empty clears", () => {
  const fee = PARAMS.test.deployFeeLit;
  assert.equal(normalizeLink("x", "@Notus_Pad"), "Notus_Pad");
  assert.equal(normalizeLink("tg", "https://t.me/notuspad/"), "notuspad");
  assert.equal(normalizeLink("web", "https://notuspad.com/"), "https://notuspad.com");
  assert.equal(normalizeLink("web", "notuspad.com"), "notuspad.com");
  assert.equal(normalizeLink("x", "not a handle"), null);
  assert.equal(normalizeLink("web", "no-dot"), null);
  assert.deepEqual(parseLinks(["x=notuspad", "web=notuspad.com"]), { x: "notuspad", web: "notuspad.com" });
  assert.equal(parseLinks(["ig=notuspad"]), null);
  assert.equal(parseLinks([]), null);
  const m = memo.links("LESTER", { x: "notuspad", tg: "notuspad", web: "https://notuspad.com" });
  assert.equal(m, "NOTUS1 links LESTER x=notuspad tg=notuspad web=https://notuspad.com");
  assert.ok(memoBytes(m) <= MEMO_MAX_BYTES);

  const events: TxEvent[] = [
    ev(ALICE, memo.deploy("CAT", "Cat", true), fee),
    ev(BOB, memo.links("CAT", { x: "bob" }), CARRY), // not the creator
    ev(ALICE, memo.links("CAT", { x: "@cat_coin", web: "cat.example" }), CARRY),
    ev(ALICE, "NOTUS1 links CAT x=has space", CARRY), // rejected, nothing changes
    ev(ALICE, memo.links("CAT", { tg: "catcoin", web: "" }), CARRY), // adds tg, clears web
  ];
  const s = replay("test", events);
  assert.deepEqual(s.coins.get("CAT")!.links, { x: "cat_coin", tg: "catcoin" });
  assert.deepEqual(s.rejected.map((r) => r.reason), ["only the creator sets the links", "bad links"]);
  assert.equal(claimableLit(s, BOB), CARRY, "the dust that carried a refused instruction is credited back");
  // gated by height on a network that says so
  const gated = replay("test", events, { ...PARAMS.test, linksFrom: 10_000 });
  assert.equal(gated.coins.get("CAT")!.links, undefined, "before the block the instruction is unknown");
  assert.equal(gated.coins.get("CAT")!.links, undefined);
});

// ---------------------------------------------------------------- rules v2

/** Real testnet addresses (the constants above are stand-ins): what rules v2 requires of a payout target. */
const REAL_BOB = walletFromSecret(bytesToHex(sha256(utf8ToBytes("bob"))), "test").address; // native segwit
const REAL_CAROL = "mq7mmsyo86cjUQ1stfqanZrVRh227tgkRA"; // legacy
const V2 = { ...PARAMS.test, rulesV2From: 0 };

test("rules v2: a payout is named after its transaction, and settled by that name", () => {
  const events = [
    ev(ALICE, memo.deploy("CAT", "Lite Cat", false), PARAMS.test.deployFeeLit),
    ev(REAL_BOB, memo.buy("CAT"), 1n * LTC),
    ev(REAL_BOB, memo.sell("CAT", 100_000_000_000_000n, 1n), CARRY),
  ];
  let s = replay("test", events, V2);
  assert.equal(s.payouts.length, 1);
  const po = s.payouts[0];
  assert.equal(po.id, events[2].txid.slice(0, 8), "the first eight hex digits of the sell's txid");
  assert.equal(po.to, REAL_BOB);
  assert.ok(rulesV2(V2, events[2].height));
  // a first-edition position does not name it, its transaction prefix does
  events.push(deskPays([{ to: REAL_BOB, lit: po.lit }], ["0"]));
  s = replay("test", events, V2);
  assert.equal(s.payouts[0].paidTxid, null, "position 0 is not a v2 id");
  const settle = deskPays([{ to: REAL_BOB, lit: po.lit }], [po.id]);
  events.push(settle);
  s = replay("test", events, V2);
  assert.equal(s.payouts[0].paidTxid, settle.txid);
  assertSolvent(events);
});

test("rules v2: colliding txid prefixes get longer ids; first-edition ids still settle by position", () => {
  const events = [
    ev(ALICE, memo.deploy("CAT", "Lite Cat", false), PARAMS.test.deployFeeLit),
    ev(REAL_BOB, memo.buy("CAT"), 1n * LTC),
    ev(REAL_BOB, memo.sell("CAT", 100_000_000_000_000n, 1n), CARRY),
    ev(REAL_BOB, memo.sell("CAT", 100_000_000_000_000n, 1n), CARRY),
  ];
  // force the two sells to share their first eight hex digits
  events[2].txid = "abcdef01" + "1".repeat(56);
  events[3].txid = "abcdef01" + "2".repeat(56);
  const s = replay("test", events, V2);
  assert.deepEqual(s.payouts.map((p) => p.id), ["abcdef01", "abcdef012222"], "the second takes a longer prefix");
  // before the switch ids are positions, and a paid memo names them by position
  const legacy = [
    ev(ALICE, memo.deploy("DOG", "Dog", false), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("DOG"), 1n * LTC),
    ev(BOB, memo.sell("DOG", 100_000_000_000_000n, 1n), CARRY),
  ];
  let l = replay("test", legacy);
  assert.equal(l.payouts[0].id, "0");
  const settle = deskPays([{ to: BOB, lit: l.payouts[0].lit }], ["0"]);
  l = replay("test", [...legacy, settle]);
  assert.equal(l.payouts[0].paidTxid, settle.txid);
  // …and a v2-looking id does not reach a first-edition payout
  const miss = deskPays([{ to: BOB, lit: l.payouts[0].lit }], ["00000000"]);
  l = replay("test", [...legacy, miss]);
  assert.equal(l.payouts[0].paidTxid, null);
});

test("rules v2: only addresses the network can pay may receive a payout, a claim or a send", () => {
  const events = [
    ev(ALICE, memo.deploy("CAT", "Lite Cat", true), PARAMS.test.deployFeeLit),
    ev(REAL_BOB, memo.buy("CAT"), 1n * LTC),
  ];
  const s0 = replay("test", events, V2);
  const bal = s0.balances.get("CAT")!.get(REAL_BOB)!;
  // a sell pointing at a string the builder cannot pay is refused, nothing moves
  const odd = ev(REAL_BOB, memo.sell("CAT", bal, 1n, 2), CARRY, [{ address: "tltc1zw508d6qejxtdg4y5r3zarvaryv98gj9p", lit: 1000n }]);
  let s = replay("test", [...events, odd], V2);
  assert.equal(s.payouts.length, 0);
  assert.equal(s.balances.get("CAT")!.get(REAL_BOB), bal);
  assert.match(s.rejected.at(-1)!.reason, /bad payout output/);
  // a Bitcoin address is not a Litecoin one either
  const btc = ev(REAL_BOB, memo.sell("CAT", bal, 1n, 2), CARRY, [{ address: "tb1qd98w32hx5s0nsxzetw6uwujm4ts5q7eq5dr5qx", lit: 1000n }]);
  s = replay("test", [...events, btc], V2);
  assert.equal(s.payouts.length, 0);
  // a send to an unpayable address is refused too; to a legacy address it goes through
  const badSend = ev(REAL_BOB, memo.send("CAT", 1_000n, 2), CARRY, [{ address: "tltc1zw508d6qejxtdg4y5r3zarvaryv98gj9p", lit: 1000n }]);
  s = replay("test", [...events, badSend], V2);
  assert.match(s.rejected.at(-1)!.reason, /bad recipient output/);
  const goodSend = ev(REAL_BOB, memo.send("CAT", 1_000n, 2), CARRY, [{ address: REAL_CAROL, lit: 1000n }]);
  s = replay("test", [...events, goodSend], V2);
  assert.equal(s.balances.get("CAT")!.get(REAL_CAROL), 1_000n);
  // a payable target: the sell goes through and the payout points at it
  const ok = ev(REAL_BOB, memo.sell("CAT", bal, 1n, 2), CARRY, [{ address: REAL_CAROL, lit: 1000n }]);
  s = replay("test", [...events, ok], V2);
  assert.equal(s.payouts.length, 1);
  assert.equal(s.payouts[0].to, REAL_CAROL);
  // before the switch the same odd string passes (history is history)
  const v1 = replay("test", [...events, odd]);
  assert.equal(v1.payouts.length, 1);
});

test("rules v2: a holder registers where their coins go on LitVM; it moves no value and survives the freeze", () => {
  const events = [
    ev(ALICE, memo.deploy("CAT", "Lite Cat", false), PARAMS.test.deployFeeLit),
    ev(REAL_BOB, memo.buy("CAT"), 1n * LTC),
  ];
  const before = replay("test", events, V2);
  const rootBefore = before.roots.at(-1)!.root;
  const reg = ev(REAL_BOB, memo.evm("0xAbCdEf0123456789abcdef0123456789ABCDEF01"), CARRY);
  let s = replay("test", [...events, reg], V2);
  assert.equal(s.evm.get(REAL_BOB), "0xabcdef0123456789abcdef0123456789abcdef01", "stored lower-case");
  assert.equal(claimableLit(s, REAL_BOB) - claimableLit(before, REAL_BOB), CARRY, "the dust that carried it is credited back");
  assert.notEqual(s.roots.at(-1)!.root, rootBefore, "a registration is part of the state root");
  assert.equal(snapshot(s).evm[REAL_BOB], "0xabcdef0123456789abcdef0123456789abcdef01");
  // a bad address is refused, the dust still credited
  s = replay("test", [...events, ev(REAL_BOB, memo.evm("0x1234"), CARRY)], V2);
  assert.equal(s.evm.size, 0);
  assert.match(s.rejected.at(-1)!.reason, /bad evm address/);
  // after the freeze it still applies, and can be changed until the snapshot
  const frozen = { ...V2, freezeHeight: reg.height };
  const later = ev(REAL_BOB, memo.evm("0x0000000000000000000000000000000000000002"), CARRY);
  s = replay("test", [...events, reg, later], frozen);
  assert.equal(s.evm.get(REAL_BOB), "0x0000000000000000000000000000000000000002");
  // before rules v2 the instruction is just an unknown command
  const v1 = replay("test", [...events, reg]);
  assert.equal(v1.evm.size, 0);
  assert.match(v1.rejected.at(-1)!.reason, /unknown command/);
  // a state without registrations keeps the root it always had
  assert.equal(replay("test", events, V2).roots.at(-1)!.root, rootBefore);
});
