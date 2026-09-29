// The desk's payout round against a fake chain: what it must never do is pay twice.
//   node --test --experimental-strip-types litecoin/payout.test.ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, ChainApi, txidOf, type EsploraStatus, type EsploraTx, type EsploraUtxo, type Fees } from "../web/lib/litecoin/esplora.ts";
import { Fallback } from "../web/lib/litecoin/chain.ts";
import { parseTx, walletFromSecret, type Utxo } from "../web/lib/litecoin/tx.ts";

const DIR = mkdtempSync(join(tmpdir(), "notus-payout-"));
// fixed secrets (any 32-byte value under the curve order is a key); this directory has no node_modules of its own
const SECRET = "11".repeat(32);
const desk = walletFromSecret(SECRET, "test");
const bob = walletFromSecret("22".repeat(32), "test").address;
const carol = walletFromSecret("33".repeat(32), "test").address;
process.env.NOTUS_LTC_NETWORK = "test";
process.env.NOTUS_LTC_DESK_KEY = SECRET;
process.env.NOTUS_LTC_STATE = join(DIR, "state.json");
process.env.NOTUS_LTC_SENT = join(DIR, "sent-payouts.json");
process.env.NOTUS_LTC_API = "http://fake.invalid/api";

type Mod = typeof import("./payout.ts");
let mod: Mod;
before(async () => {
  mod = await import("./payout.ts");
});

const LTC = 100_000_000n;
const utxo = (n: number, value: bigint, confirmed = true): Utxo => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, confirmed });
type Payout = { id: string; kind: string; to: string; lit: string; txid: string; paidTxid: string | null };
const payout = (id: string, to: string, lit: bigint, paid: string | null = null): Payout => ({ id, kind: "sell", to, lit: lit.toString(), txid: id.padEnd(64, "a"), paidTxid: paid });

/** A chain that remembers what was broadcast and answers about it. */
class FakeApi extends ChainApi {
  readonly label = "fake";
  utxoList: Utxo[] = [];
  known = new Map<string, EsploraStatus>();
  broadcasts: string[] = [];
  fee = 10;
  /** What broadcast() throws for a given hex, if anything; `relayAnyway` still marks the transaction known, as a node that heard it would. */
  refuse: (hex: string) => Error | null = () => null;
  relayAnyway = false;
  onBroadcast: ((hex: string) => void) | null = null;
  async tipHeight() {
    return 3_000_000;
  }
  async blockHash() {
    return "11".repeat(32);
  }
  async addressTxsChain(): Promise<EsploraTx[]> {
    return [];
  }
  async addressTxsMempool(): Promise<EsploraTx[]> {
    return [];
  }
  async tx(): Promise<EsploraTx> {
    throw new ApiError("not found", 404);
  }
  async txStatus(txid: string): Promise<EsploraStatus> {
    const s = this.known.get(txid);
    if (!s) throw new ApiError("not found", 404);
    return s;
  }
  async blockTxids(): Promise<string[]> {
    return [];
  }
  async rawUtxos(): Promise<EsploraUtxo[]> {
    return this.utxoList.map((u) => ({ txid: u.txid, vout: u.vout, value: Number(u.value), status: { confirmed: u.confirmed } }));
  }
  async broadcast(hex: string): Promise<string> {
    this.broadcasts.push(hex);
    this.onBroadcast?.(hex);
    const txid = txidOf(hex);
    const err = this.refuse(hex);
    if (err) {
      if (this.relayAnyway) this.known.set(txid, { confirmed: false });
      throw err;
    }
    this.known.set(txid, { confirmed: false });
    return txid;
  }
  async fees(): Promise<Fees> {
    return { fastestFee: this.fee, halfHourFee: this.fee, hourFee: this.fee };
  }
}

function scenario(payouts: Payout[], utxos: Utxo[], liabilitiesLit?: bigint) {
  const api = new FakeApi();
  api.utxoList = utxos;
  writeFileSync(
    process.env.NOTUS_LTC_STATE!,
    JSON.stringify({ payouts, desk: { address: desk.address }, liabilitiesLit: (liabilitiesLit ?? payouts.reduce((t, p) => t + (p.paidTxid ? 0n : BigInt(p.lit)), 0n)).toString(), chainTip: 3_000_000, confirmations: 2 })
  );
  if (existsSync(process.env.NOTUS_LTC_SENT!)) rmSync(process.env.NOTUS_LTC_SENT!);
  return api;
}
const intents = () => (JSON.parse(readFileSync(process.env.NOTUS_LTC_SENT!, "utf8")) as { intents: import("./payout.ts").Intent[] }).intents;
const quiet = () => {};
const inputsOf = (hex: string) => parseTx(hex, "test").inputs.map((i) => `${i.txid}:${i.vout}`);

test("a payout is paid once: the intent is on disk before the broadcast, and covers the payout afterwards", async () => {
  const api = scenario([payout("a1b2c3d4", bob, 500_000n)], [utxo(1, 1n * LTC)]);
  let seenBeforeBroadcast: string | null = null;
  api.onBroadcast = (hex) => {
    const it = intents().find((i) => i.txid === txidOf(hex));
    seenBeforeBroadcast = it ? it.status : null;
  };
  assert.equal(await mod.payDue(false, quiet, { api }), 1);
  assert.equal(seenBeforeBroadcast, "sent", "the intent was written before the network heard of the transaction");
  assert.equal(api.broadcasts.length, 1);
  const [it] = intents();
  assert.deepEqual(it.ids, ["a1b2c3d4"]);
  assert.equal(it.hex, api.broadcasts[0]);
  assert.equal(it.inputs.length, 1);
  assert.equal(it.inputs[0].txid, utxo(1, 0n).txid);
  // the memo names the payout by its id
  assert.match(parseTx(it.hex!, "test").outputs.find((o) => o.memo)!.memo!, /^NOTUS1 paid a1b2c3d4$/);
  // the next round finds it in flight: nothing more is built or sent
  assert.equal(await mod.payDue(false, quiet, { api }), 0);
  assert.equal(api.broadcasts.length, 1);
  assert.equal(intents().length, 1);
});

test("a broadcast that errors after the node relayed it is not paid again", async () => {
  const api = scenario([payout("b1b2c3d4", bob, 500_000n)], [utxo(2, 1n * LTC), utxo(3, 1n * LTC)]);
  api.refuse = () => new ApiError("tx: The operation was aborted due to timeout", 0);
  api.relayAnyway = true;
  assert.equal(await mod.payDue(false, quiet, { api }), 0, "counted as not paid…");
  assert.equal(intents()[0].status, "sent", "…but remembered as sent: the error was the explorer's, not the transaction's");
  api.refuse = () => null;
  // next round: the network knows it, so it stays covered; no second transaction
  assert.equal(await mod.payDue(false, quiet, { api }), 0);
  assert.equal(api.broadcasts.length, 1);
  assert.equal(intents().length, 1);
});

test("a transaction the network forgot is rebroadcast from its stored hex, same txid", async () => {
  const api = scenario([payout("c1b2c3d4", bob, 500_000n)], [utxo(4, 1n * LTC)]);
  await mod.payDue(false, quiet, { api });
  const txid = intents()[0].txid;
  api.known.delete(txid); // evicted
  await mod.payDue(false, quiet, { api });
  assert.equal(api.broadcasts.length, 2);
  assert.equal(txidOf(api.broadcasts[1]), txid, "the very same transaction again");
  assert.equal(intents().length, 1);
  assert.match(intents()[0].note ?? "", /rebroadcast/);
});

test("only confirmed coins and the desk's own change are spent", async () => {
  // the big coin is somebody's unconfirmed payment: it must not be touched
  const api = scenario([payout("d1b2c3d4", bob, 500_000n), payout("d2b2c3d4", carol, 400_000n)], [utxo(5, 10n * LTC, false), utxo(6, 1n * LTC)]);
  const logs: string[] = [];
  assert.equal(await mod.payDue(false, (l) => logs.push(l), { api }), 2, "both fit in one transaction on the confirmed coin");
  assert.deepEqual(inputsOf(api.broadcasts[0]), [`${utxo(6, 0n).txid}:0`]);
  // a payout only the unconfirmed coin could cover waits, it is not paid with it
  const api2 = scenario([payout("d3b2c3d4", bob, 5n * LTC)], [utxo(7, 10n * LTC, false), utxo(8, 700_000n)]);
  const logs2: string[] = [];
  assert.equal(await mod.payDue(false, (l) => logs2.push(l), { api: api2 }), 0);
  assert.ok(logs2.some((l) => /insufficient funds/.test(l)), logs2.join("\n"));
  assert.equal(api2.broadcasts.length, 0);
  // the change of the desk's own transaction is spendable right away
  const api3 = scenario([payout("d4b2c3d4", bob, 500_000n)], [utxo(9, 1n * LTC)]);
  await mod.payDue(false, quiet, { api: api3 });
  const first = txidOf(api3.broadcasts[0]);
  const change = parseTx(api3.broadcasts[0], "test").outputs.at(-1)!;
  api3.utxoList = [{ txid: first, vout: 2, value: change.lit, confirmed: false }]; // the explorer lists it, unconfirmed
  writeFileSync(process.env.NOTUS_LTC_STATE!, JSON.stringify({ payouts: [payout("d4b2c3d4", bob, 500_000n), payout("d5b2c3d4", carol, 300_000n)], desk: { address: desk.address }, liabilitiesLit: "800000" }));
  assert.equal(await mod.payDue(false, quiet, { api: api3 }), 1);
  assert.deepEqual(inputsOf(api3.broadcasts[1]), [`${first}:2`]);
});

test("a transaction the network keeps refusing is given up after enough rounds, and its payouts are paid again with the same coins", async () => {
  const api = scenario([payout("e1b2c3d4", bob, 500_000n)], [utxo(10, 1n * LTC), utxo(11, 1n * LTC)]);
  // the network refuses this one transaction for good (say, a relay policy its fee does not meet)
  let refused: string | null = null;
  api.refuse = (hex) => (refused === null || hex === refused ? ((refused = hex), new ApiError("broadcast rejected: min relay fee not met", 400)) : null);
  assert.equal(await mod.payDue(false, quiet, { api }), 0);
  assert.equal(intents()[0].status, "rejected");
  const firstInputs = inputsOf(api.broadcasts[0]);
  for (let round = 1; round < mod.GIVE_UP_ROUNDS; round++) {
    assert.equal(await mod.payDue(false, quiet, { api }), 0, `round ${round}: still watching`);
    assert.equal(intents()[0].status, "rejected");
    assert.equal(intents().length, 1, "no second transaction while the first is watched");
  }
  api.fee = 20; // fees have moved on: the replacement is a different transaction, and this one the network takes
  assert.equal(await mod.payDue(false, quiet, { api }), 1, "given up, paid again");
  const list = intents();
  assert.equal(list[0].status, "dead");
  assert.equal(list[1].status, "sent");
  assert.ok(inputsOf(api.broadcasts.at(-1)!).some((i) => firstInputs.includes(i)), "the replacement spends a coin of the given-up transaction: at most one of them can ever confirm");
});

test("a payout the builder cannot pay is set aside on its own; the rest of the batch goes through", async () => {
  const api = scenario([payout("f1b2c3d4", bob, 500_000n), payout("f2b2c3d4", "tltc1zw508d6qejxtdg4y5r3zarvaryv98gj9p", 500_000n), payout("f3b2c3d4", carol, 500_000n)], [utxo(12, 1n * LTC)]);
  const logs: string[] = [];
  assert.equal(await mod.payDue(false, (l) => logs.push(l), { api }), 2);
  const list = intents();
  assert.deepEqual(list.filter((i) => i.status === "sent").flatMap((i) => i.ids).sort(), ["f1b2c3d4", "f3b2c3d4"]);
  const bad = list.find((i) => i.status === "unpayable")!;
  assert.deepEqual(bad.ids, ["f2b2c3d4"]);
  assert.match(bad.note ?? "", /bad address/);
  // and it stays set aside, not retried every round
  assert.equal(await mod.payDue(false, quiet, { api }), 0);
  assert.equal(mod.payoutStatus().unpayable, 1);
});

test("a payout stuck in the mempool is fee-bumped with the same coins once fees have risen", async () => {
  const api = scenario([payout("a2b2c3d4", bob, 500_000n)], [utxo(13, 1n * LTC), utxo(14, 1n * LTC)]);
  const t0 = 1_800_000_000;
  await mod.payDue(false, quiet, { api, now: t0 });
  const original = intents()[0];
  // still unconfirmed an hour later, fees up threefold
  api.fee = 30;
  assert.equal(await mod.payDue(false, quiet, { api, now: t0 + mod.BUMP_AFTER_S + 60 }), 0, "a bump is not a new payout");
  const list = intents();
  assert.equal(list.length, 2);
  assert.equal(list[0].status, "replaced");
  assert.equal(list[0].replacedBy, list[1].txid);
  assert.equal(list[1].replaces, original.txid);
  assert.deepEqual(inputsOf(api.broadcasts[1]), inputsOf(api.broadcasts[0]), "same coins: the two conflict");
  const outs = parseTx(api.broadcasts[1], "test").outputs;
  assert.equal(outs[0].address, bob);
  assert.equal(outs[0].lit, 500_000n);
  assert.ok(list[1].feeRate > list[0].feeRate);
  // the memo still names the same payout, so whichever confirms settles it
  assert.match(outs.find((o) => o.memo)!.memo!, /^NOTUS1 paid a2b2c3d4$/);
});

test("with two explorers, a payout whose sell they disagree about is held", async () => {
  const a = scenario([payout("b3b2c3d4", bob, 500_000n)], [utxo(15, 1n * LTC)]);
  const b = new FakeApi();
  b.utxoList = a.utxoList;
  a.known.set("b3b2c3d4".padEnd(64, "a"), { confirmed: true, block_height: 2_999_990 });
  // b has never heard of the sell
  const both = new Fallback([a, b], "test");
  const logs: string[] = [];
  assert.equal(await mod.payDue(false, (l) => logs.push(l), { api: both }), 0);
  assert.ok(logs.some((l) => /disagree/.test(l)), logs.join("\n"));
  assert.equal(a.broadcasts.length + b.broadcasts.length, 0);
  // once both agree it is paid
  b.known.set("b3b2c3d4".padEnd(64, "a"), { confirmed: true, block_height: 2_999_990 });
  assert.equal(await mod.payDue(false, quiet, { api: both }), 1);
});

test("the first edition of the sent file is understood: its payouts stay covered", async () => {
  const api = scenario([payout("0", bob, 500_000n), payout("1", carol, 400_000n, "ff".repeat(32))], [utxo(16, 1n * LTC)]);
  writeFileSync(process.env.NOTUS_LTC_SENT!, JSON.stringify({ "0": "ab".repeat(32) }));
  const store = mod.loadIntents();
  assert.equal(store.version, 2);
  assert.deepEqual(store.intents[0].ids, ["0"]);
  assert.equal(store.intents[0].hex, null);
  assert.equal(await mod.payDue(false, quiet, { api }), 0, "#0 was sent by the old desk, #1 is paid: nothing due");
  assert.equal(api.broadcasts.length, 0);
});

test("the ledger folding a payment in marks its intent confirmed", async () => {
  const api = scenario([payout("c3b2c3d4", bob, 500_000n)], [utxo(17, 1n * LTC)]);
  await mod.payDue(false, quiet, { api });
  const txid = intents()[0].txid;
  writeFileSync(process.env.NOTUS_LTC_STATE!, JSON.stringify({ payouts: [payout("c3b2c3d4", bob, 500_000n, txid)], desk: { address: desk.address }, liabilitiesLit: "0" }));
  await mod.payDue(false, quiet, { api });
  assert.equal(intents()[0].status, "confirmed");
  assert.equal(mod.payoutStatus().live, 0);
});
