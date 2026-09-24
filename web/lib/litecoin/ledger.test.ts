// Run with: node --test web/lib/litecoin/ledger.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURVE_SUPPLY,
  MEMO_MAX_BYTES,
  PARAMS,
  claimableLit,
  liabilitiesLit,
  memo,
  memoBytes,
  replay,
  snapshot,
  spotPrice,
  type TxEvent,
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
function deskPays(payouts: { to: string; lit: bigint }[], ids: number[], opts: Partial<TxEvent> = {}): TxEvent {
  seq++;
  return {
    height: 1000 + seq, txIndex: 0, txid: seq.toString(16).padStart(64, "0"), time: 1_700_000_000 + seq * 150,
    sender: DESK, valueLit: 0n, memo: memo.paid(ids), fromDesk: true,
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
  events.push(ev(MALLORY, memo.paid([0]), CARRY));
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

test("curve sells out: surplus is credited, sells reopen the curve", () => {
  const events = [
    ev(ALICE, memo.deploy("TOP", "Top", false), PARAMS.test.deployFeeLit),
    ev(BOB, memo.buy("TOP"), 5n * LTC), // the curve only needs ~0.65 LTC
  ];
  let s = assertSolvent(events);
  assert.equal(s.coins.get("TOP")!.sold, CURVE_SUPPLY);
  assert.ok(claimableLit(s, BOB) > 4n * LTC, "surplus stays the buyer's");

  events.push(ev(BOB, memo.buy("TOP"), LTC));
  s = assertSolvent(events);
  assert.match(s.rejected.at(-1)!.reason, /sold out/);

  events.push(ev(BOB, memo.sell("TOP", CURVE_SUPPLY / 2n, 0n), CARRY));
  events.push(ev(ALICE, memo.buy("TOP"), LTC / 100n));
  s = assertSolvent(events);
  assert.ok(s.balances.get("TOP")!.get(ALICE)! > 0n, "buying works again after a sell");
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
