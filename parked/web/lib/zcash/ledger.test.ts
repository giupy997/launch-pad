// Run with: node --test web/lib/zcash/ledger.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURVE_SUPPLY,
  PARAMS,
  claimableZat,
  liabilitiesZat,
  memo,
  newHolderKey,
  replay,
  sign,
  spotPrice,
  type MemoEvent,
} from "./ledger.ts";

const ZEC = 100_000_000n;
const ADDR = "utest1" + "q".repeat(60);

let seq = 0;
function ev(memoText: string, valueZat: bigint, opts: Partial<MemoEvent> = {}): MemoEvent {
  seq++;
  return {
    height: 1000 + seq, txIndex: 0, outputIndex: 0, txid: seq.toString(16).padStart(64, "0"),
    time: 1_700_000_000 + seq * 75, valueZat, memo: memoText, fromDesk: false, ...opts,
  };
}

/** received − paid out must cover everything owed plus the treasury. */
function assertSolvent(events: MemoEvent[]) {
  const s = replay("test", events);
  let inflow = 0n;
  for (const e of events) if (!e.fromDesk) inflow += e.valueZat;
  let paid = 0n;
  for (const p of s.payouts) if (p.paidTxid) paid += p.zat;
  const owed = liabilitiesZat(s) + s.treasuryZat;
  assert.ok(inflow - paid >= owed, `insolvent: holds ${inflow - paid}, owes ${owed}`);
  assert.ok(inflow - paid - owed < 10_000n, "no more than rounding dust unaccounted for");
  return s;
}

test("deploy, buy, price rises, creator-mode fee split", () => {
  const creator = newHolderKey(), bob = newHolderKey();
  const events = [
    ev(memo.deploy("CAT", "Zcash Cat", creator.holder, false), PARAMS.test.deployFeeZat),
    ev(memo.buy("CAT", bob.holder), ZEC / 10n),
  ];
  const s = assertSolvent(events);
  const coin = s.coins.get("CAT")!;
  assert.equal(coin.name, "Zcash Cat");
  assert.ok(s.balances.get("CAT")!.get(bob.holder)! > 0n);
  assert.ok(spotPrice(coin) > Number(PARAMS.test.virtualZat) / 1.05e17, "price moved up from the opening price");
  // 1% fee = 100_000 zat: 80% creator credit, 20% (+ deploy fee) treasury
  assert.equal(claimableZat(s, creator.holder), 80_000n);
  assert.equal(s.treasuryZat, 20_000n + PARAMS.test.deployFeeZat);
  assert.equal(claimableZat(s, bob.holder), 0n);
});

test("holders mode: cashback pro-rata, claim becomes a payout the desk confirms", () => {
  const creator = newHolderKey(), bob = newHolderKey(), carol = newHolderKey();
  const events = [
    ev(memo.deploy("RWD", "Rewards", creator.holder, true), PARAMS.test.deployFeeZat),
    ev(memo.buy("RWD", bob.holder), ZEC / 10n),
    ev(memo.buy("RWD", carol.holder), ZEC / 10n),
  ];
  let s = assertSolvent(events);
  assert.equal(claimableZat(s, creator.holder), 0n, "nothing to the creator in holders mode");
  const bobCb = claimableZat(s, bob.holder), carolCb = claimableZat(s, carol.holder);
  assert.ok(bobCb > carolCb && carolCb > 0n, "bob earned on both buys, carol on hers");
  assert.ok(160_000n - (bobCb + carolCb) < 10n, "80% of both fees reaches the holders");

  events.push(ev(memo.claim(bob.secret, "test", ADDR, 1n), 1_000n));
  s = assertSolvent(events);
  assert.equal(s.payouts.length, 1);
  assert.equal(s.payouts[0].zat, bobCb + 1_000n, "cashback plus the dust that carried the claim");
  assert.equal(claimableZat(s, bob.holder), 0n);

  // only the desk can confirm, and only by paying in full
  events.push(ev(memo.paid(0), s.payouts[0].zat, { fromDesk: false }));
  assert.equal(replay("test", events).payouts[0].paidTxid, null);
  events.push(ev(memo.paid(0), s.payouts[0].zat - 1n, { fromDesk: true }));
  assert.equal(replay("test", events).payouts[0].paidTxid, null);
  events.push(ev(memo.paid(0), s.payouts[0].zat, { fromDesk: true }));
  assert.ok(replay("test", events).payouts[0].paidTxid);
});

test("sell: signature, nonce replay, balance and payout", () => {
  const creator = newHolderKey(), bob = newHolderKey(), mallory = newHolderKey();
  const base = [
    ev(memo.deploy("DOG", "Dog", creator.holder, false), PARAMS.test.deployFeeZat),
    ev(memo.buy("DOG", bob.holder), ZEC / 5n),
  ];
  const bal = replay("test", base).balances.get("DOG")!.get(bob.holder)!;

  // mallory signs a sell of bob's coins with her own key
  const forged = memo.sell(mallory.secret, "test", "DOG", bal, 0n, ADDR, 1n).replace(mallory.holder, bob.holder);
  let s = replay("test", [...base, ev(forged, 1_000n)]);
  assert.equal(s.payouts.length, 0);
  assert.equal(s.rejected.at(-1)!.reason, "bad signature");

  // a signature made for mainnet is worthless on testnet
  const wrongNet = [
    "NOTUS1", "sell", "DOG", bal, 0n, ADDR, bob.holder, 1n,
    sign(bob.secret, "main", ["sell", "DOG", bal, 0n, ADDR, bob.holder, 1n]),
  ].join(" ");
  assert.equal(replay("test", [...base, ev(wrongNet, 1_000n)]).rejected.at(-1)!.reason, "bad signature");

  const good = memo.sell(bob.secret, "test", "DOG", bal / 2n, 0n, ADDR, 1n);
  const events = [...base, ev(good, 1_000n)];
  s = assertSolvent(events);
  assert.equal(s.payouts.length, 1);
  assert.equal(s.payouts[0].to, ADDR);
  assert.equal(s.balances.get("DOG")!.get(bob.holder), bal - bal / 2n);

  // replaying the very same memo does nothing
  events.push(ev(good, 1_000n));
  s = assertSolvent(events);
  assert.equal(s.payouts.length, 1);
  assert.equal(s.rejected.at(-1)!.reason, "stale nonce");

  // cannot sell more than owned
  events.push(ev(memo.sell(bob.secret, "test", "DOG", bal, 0n, ADDR, 2n), 1_000n));
  assert.equal(assertSolvent(events).rejected.at(-1)!.reason, "insufficient balance");
});

test("send moves coins; self-send cannot mint cashback", () => {
  const creator = newHolderKey(), bob = newHolderKey(), carol = newHolderKey();
  const events = [
    ev(memo.deploy("SND", "Send", creator.holder, true), PARAMS.test.deployFeeZat),
    ev(memo.buy("SND", bob.holder), ZEC / 5n),
    ev(memo.buy("SND", carol.holder), ZEC / 5n),
  ];
  const before = replay("test", events);
  const bal = before.balances.get("SND")!.get(bob.holder)!;
  const honest = claimableZat(before, bob.holder);

  for (let n = 1n; n <= 10n; n++) events.push(ev(memo.send(bob.secret, "test", "SND", bal, bob.holder, n), 1_000n));
  let s = assertSolvent(events);
  assert.equal(claimableZat(s, bob.holder) - honest, 10_000n, "only the carried dust was credited");

  events.push(ev(memo.send(bob.secret, "test", "SND", bal / 4n, carol.holder, 11n), 1_000n));
  s = assertSolvent(events);
  assert.equal(s.balances.get("SND")!.get(bob.holder), bal - bal / 4n);
});

test("curve sells out: surplus is credited, sells reopen the curve", () => {
  const creator = newHolderKey(), whale = newHolderKey();
  const events = [
    ev(memo.deploy("TOP", "Top", creator.holder, false), PARAMS.test.deployFeeZat),
    ev(memo.buy("TOP", whale.holder), 5n * ZEC), // the curve only needs ~0.97 ZEC
  ];
  let s = assertSolvent(events);
  assert.equal(s.coins.get("TOP")!.sold, CURVE_SUPPLY);
  assert.ok(claimableZat(s, whale.holder) > 4n * ZEC, "surplus stays the buyer's");

  events.push(ev(memo.buy("TOP", whale.holder), ZEC));
  s = assertSolvent(events);
  assert.match(s.rejected.at(-1)!.reason, /sold out/);

  events.push(ev(memo.sell(whale.secret, "test", "TOP", CURVE_SUPPLY / 2n, 0n, ADDR, 1n), 1_000n));
  events.push(ev(memo.buy("TOP", creator.holder), ZEC / 100n));
  s = assertSolvent(events);
  assert.ok(s.balances.get("TOP")!.get(creator.holder)! > 0n, "buying works again after a sell");
});

test("first paid deploy wins the ticker; garbage is ignored", () => {
  const a = newHolderKey(), b = newHolderKey();
  const events = [
    ev(memo.deploy("ONE", "First", a.holder, false), PARAMS.test.deployFeeZat),
    ev(memo.deploy("ONE", "Second", b.holder, true), PARAMS.test.deployFeeZat + 5_000n),
    ev("hello there", 12_345n),
    ev("NOTUS1 deploy x", 1n),
    ev(memo.deploy("CHEAP", "Underpaid", b.holder, false), PARAMS.test.deployFeeZat - 1n),
  ];
  const s = replay("test", events);
  assert.equal(s.coins.get("ONE")!.name, "First");
  assert.equal(claimableZat(s, b.holder), PARAMS.test.deployFeeZat + 5_000n, "late deploy is refundable");
  assert.equal(s.coins.has("CHEAP"), false);
  assert.equal(s.rejected.length, 4);
});

test("deterministic: input order does not matter, roots match", () => {
  const creator = newHolderKey(), bob = newHolderKey();
  const events = [
    ev(memo.deploy("DET", "Det", creator.holder, true), PARAMS.test.deployFeeZat + 50_000n),
    ev(memo.buy("DET", bob.holder), ZEC / 7n),
    ev(memo.buy("DET", creator.holder), ZEC / 9n),
  ];
  const a = replay("test", events), b = replay("test", [...events].reverse());
  assert.equal(a.roots.at(-1)!.root, b.roots.at(-1)!.root);
  assert.equal(a.roots.length, 3);
});

test("fuzz: solvent after every memo", () => {
  let rnd = 0xc0ffee;
  const next = (n: number) => ((rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0) % n);
  const keys = Array.from({ length: 5 }, newHolderKey);
  const nonces = new Map<string, bigint>();
  const bump = (h: string) => { const n = (nonces.get(h) ?? 0n) + 1n; nonces.set(h, n); return n; };
  const events = [
    ev(memo.deploy("FZA", "Fuzz A", keys[0].holder, true), PARAMS.test.deployFeeZat),
    ev(memo.deploy("FZB", "Fuzz B", keys[1].holder, false), PARAMS.test.deployFeeZat + 1_000_000n),
  ];
  for (let i = 0; i < 300; i++) {
    const k = keys[next(5)], ticker = next(2) ? "FZA" : "FZB";
    const s = replay("test", events);
    const bal = s.balances.get(ticker)?.get(k.holder) ?? 0n;
    const op = next(5);
    if (op <= 1) events.push(ev(memo.buy(ticker, k.holder), BigInt(1 + next(40_000_000))));
    else if (op === 2 && bal > 0n) events.push(ev(memo.sell(k.secret, "test", ticker, (bal * BigInt(1 + next(100))) / 100n, 0n, ADDR, bump(k.holder)), 1_000n));
    else if (op === 3 && bal > 0n) events.push(ev(memo.send(k.secret, "test", ticker, (bal * BigInt(1 + next(100))) / 100n, keys[next(5)].holder, bump(k.holder)), 1_000n));
    else events.push(ev(memo.claim(k.secret, "test", ADDR, bump(k.holder)), 1_000n));
    if (i % 10 === 0) assertSolvent(events);
  }
  const s = assertSolvent(events);
  assert.ok(s.trades.length > 50 && s.payouts.length > 5, "the fuzz actually traded and paid out");
});
