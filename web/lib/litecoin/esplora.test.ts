// The chain readers: an Esplora endpoint, a Blockbook one read in Esplora's
// dialect, and several in fallback (tried in order when one is down, never
// one that serves the other chain). Run with:
//   node --test --experimental-strip-types lib/litecoin/esplora.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { Esplora, GENESIS, eventFromTx, pendingFromTx } from "./esplora.ts";
import { Blockbook, scriptType, type BbTx } from "./blockbook.ts";
import { Fallback, chainApi } from "./chain.ts";
import { buildTx, parseTx, walletFromSecret, type Utxo } from "./tx.ts";

type Route = (init?: RequestInit) => Response | Promise<Response>;

/** A fake internet: URL → handler; everything else is unreachable. Counts the calls. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const route = routes[u];
    if (!route) throw new TypeError(`fetch failed: ${u}`);
    return route(init);
  }) as typeof fetch;
  return calls;
}
const text = (body: string, status = 200) => () => new Response(body, { status });
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const cloudflare = (status: number) => text(`<!DOCTYPE html><title>${status}</title>`, status);

const secret = bytesToHex(sha256(utf8ToBytes("notus-litecoin-test-user")));
const user = walletFromSecret(secret, "test");
const desk = walletFromSecret(bytesToHex(sha256(utf8ToBytes("notus-litecoin-test-desk"))), "test");
const coin: Utxo = { txid: "1".padStart(64, "0"), vout: 1, value: 1_000_000n, confirmed: true };
const built = buildTx({ network: "test", secret, utxos: [coin], payments: [{ address: desk.address, lit: 200_000n }], memo: "NOTUS1 buy CAT", feeRate: 10n });
const pendingBuilt = buildTx({ network: "test", secret, utxos: [coin], payments: [{ address: desk.address, lit: 10_000n }], memo: "NOTUS1 claim", feeRate: 10n });

/** The transaction as Blockbook lists it (amounts as strings, vout 0 omitted, addresses resolved). */
function blockbookTx(b: typeof built, mined: boolean, withHex = true): BbTx {
  const parsed = parseTx(b.hex, "test");
  return {
    txid: b.txid,
    version: 2,
    vin: [{ txid: coin.txid, vout: coin.vout, sequence: 0xffffffff, n: 0, addresses: [user.address], isAddress: true, value: coin.value.toString() }],
    vout: parsed.outputs.map((o, n) => ({ value: o.lit.toString(), n, hex: o.script, addresses: o.address ? [o.address] : ["OP_RETURN (NOTUS1 …)"], isAddress: !!o.address })),
    ...(mined ? { blockHash: "ab".repeat(32), blockHeight: 3_600_100, confirmations: 3 } : { blockHeight: -1, confirmations: 0 }),
    blockTime: 1_790_000_000,
    size: b.hex.length / 2,
    fees: b.fee.toString(),
    ...(withHex ? { hex: b.hex } : {}),
  };
}

test("fallback: the next endpoint on a 5xx or an unreachable one, never on a 4xx", async () => {
  const calls = fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.main),
    "https://b/api/block-height/0": text(GENESIS.main),
    "https://a/api/blocks/tip/height": cloudflare(522),
    "https://b/api/blocks/tip/height": text("3185373"),
    "https://a/api/tx/aa": text('{"error":"no"}', 404),
    "https://b/api/tx/aa": text('{"txid":"aa"}'),
    "https://b/api/address/x/utxo": text("[]"),
  });
  const api = chainApi("https://a/api, https://b/api/", "main") as Fallback;
  assert.deepEqual(api.backends.map((b) => (b as Esplora).base), ["https://a/api", "https://b/api"]);
  assert.equal(await api.tipHeight(), 3185373, "a answered 522: b's answer");
  await assert.rejects(api.tx("aa"), /tx\/aa: HTTP 404/, "a 4xx is an answer, not an outage");
  assert.ok(!calls.includes("https://b/api/tx/aa"), "b was not asked");
  assert.deepEqual(await api.utxos("x"), [], "a unreachable (no route at all): b");
  assert.equal(calls.filter((c) => c.endsWith("/block-height/0")).length, 2, "each endpoint's chain is checked once");
});

test("fallback: an endpoint that failed is left alone for a while, then retried", async () => {
  const calls = fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.main),
    "https://b/api/block-height/0": text(GENESIS.main),
    "https://a/api/blocks/tip/height": cloudflare(522),
    "https://b/api/blocks/tip/height": text("3185373"),
    "https://b/api/tx/aa/status": text('{"confirmed":true,"block_height":1}'),
  });
  const api = chainApi("https://a/api,https://b/api", "main", undefined, 1000, 200);
  await api.tipHeight();
  await api.txStatus("aa");
  assert.equal(calls.filter((c) => c === "https://a/api/tx/aa/status").length, 0, "a is cooling down: b is asked first");
  await new Promise((r) => setTimeout(r, 250));
  await api.txStatus("aa");
  assert.equal(calls.filter((c) => c === "https://a/api/tx/aa/status").length, 1, "…and retried once the cooldown is over");
  // every endpoint down: they are all tried again rather than none
  fakeFetch({ "https://a/api/block-height/0": text(GENESIS.main), "https://b/api/block-height/0": text(GENESIS.main) });
  const dead = chainApi("https://a/api,https://b/api", "main", undefined, 1000, 60_000);
  await assert.rejects(dead.tipHeight(), /fetch failed/);
  await assert.rejects(dead.tipHeight(), /fetch failed/);
});

test("fallback: an endpoint on the other chain is skipped, one that cannot say is used", async () => {
  fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.main),
    "https://a/api/blocks/tip/height": cloudflare(524),
    "https://wrong/api/block-height/0": text(GENESIS.test),
    "https://wrong/api/blocks/tip/height": text("4902108"),
    "https://mute/api/block-height/0": text("not found", 404),
    "https://mute/api/blocks/tip/height": text("3185380"),
  });
  await assert.rejects(chainApi("https://a/api,https://wrong/api", "main").tipHeight(), /HTTP 524/, "the testnet explorer is never used for the mainnet desk");
  assert.equal(await chainApi("https://a/api,https://mute/api", "main").tipHeight(), 3185380);
  const single = chainApi("https://wrong/api", "main");
  assert.ok(single instanceof Esplora);
  assert.equal(await single.tipHeight(), 4902108, "a single endpoint is trusted as configured, no probe");
});

test("a single endpoint's 5xx is reported as is; a timeout counts as unreachable", async () => {
  fakeFetch({ "https://a/api/blocks/tip/height": cloudflare(520) });
  await assert.rejects(new Esplora("https://a/api").tipHeight(), /blocks\/tip\/height: HTTP 520/);
  const calls = fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.test),
    "https://b/api/block-height/0": text(GENESIS.test),
    // never answers: only the client's own timeout ends the request
    "https://a/api/v1/fees/recommended": (init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    "https://b/api/v1/fees/recommended": text('{"halfHourFee":7}'),
  });
  const slow = chainApi("https://a/api,https://b/api", "test", undefined, 50);
  const keep = setInterval(() => {}, 1000); // a real socket would keep the loop alive; the fake has none
  try {
    assert.equal(await slow.feeRate(), 7n, "a timed out: b's answer");
  } finally {
    clearInterval(keep);
  }
  assert.ok(calls.includes("https://b/api/v1/fees/recommended"));
});

test("broadcast: relayed by an endpoint that then failed counts as sent", async () => {
  const bodies: string[] = [];
  fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.test),
    "https://b/api/block-height/0": text(GENESIS.test),
    "https://a/api/tx": (init) => {
      bodies.push(String(init?.body));
      return new Response("<!DOCTYPE html>", { status: 502 });
    },
    "https://b/api/tx": text('sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}', 400),
  });
  assert.equal(await chainApi("https://a/api,https://b/api", "test").broadcast(built.hex), built.txid);
  assert.deepEqual(bodies, [built.hex]);
  fakeFetch({ "https://a/api/tx": text("sendrawtransaction RPC error: min relay fee not met", 400) });
  await assert.rejects(new Esplora("https://a/api").broadcast(built.hex), /broadcast rejected: .*min relay fee/);
});

test("blockbook: a listing becomes Esplora's, down to the sender's public key and the memo", async () => {
  const mined = blockbookTx(built, true, false); // the listing carries no raw hex: fetched per transaction, once
  const pending = blockbookTx(pendingBuilt, false);
  const calls = fakeFetch({
    "https://bb/api/v2": json({ blockbook: { coin: "Litecoin Testnet", bestHeight: 3_600_102, inSync: true }, backend: { chain: "test" } }),
    "https://bb/api/v2/block-index/0": json({ blockHash: GENESIS.test }),
    [`https://bb/api/v2/address/${desk.address}?details=txs&pageSize=50&page=1`]: json({ page: 1, totalPages: 1, transactions: [pending, mined] }),
    [`https://bb/api/v2/tx/${built.txid}`]: json(blockbookTx(built, true)),
    [`https://bb/api/v2/utxo/${desk.address}?confirmed=false`]: json([
      { txid: built.txid, value: "200000", height: 3_600_100, confirmations: 3 },
      { txid: pendingBuilt.txid, vout: 0, value: "10000", confirmations: 0 },
    ]),
    [`https://bb/api/v2/block/${"ab".repeat(32)}?page=1`]: json({ page: 1, totalPages: 1, txs: [{ txid: "11".repeat(32) }, { txid: built.txid }] }),
    "https://bb/api/v2/estimatefee/2": json({ result: "0.00002500" }),
  });
  const bb = new Blockbook("https://bb/api/v2/", "test");
  assert.equal(await bb.tipHeight(), 3_600_102);
  assert.equal(await bb.blockHash(0), GENESIS.test);

  const chain = await bb.addressTxsChain(desk.address);
  assert.equal(chain.length, 1, "the mempool entry is not part of the chain history");
  const tx = chain[0];
  assert.deepEqual(tx.status, { confirmed: true, block_height: 3_600_100, block_hash: "ab".repeat(32), block_time: 1_790_000_000 });
  assert.equal(tx.vin[0].prevout?.scriptpubkey_address, user.address);
  assert.equal(tx.vin[0].prevout?.scriptpubkey_type, "v0_p2wpkh");
  assert.equal(tx.vin[0].prevout?.value, 1_000_000);
  assert.equal(tx.vin[0].witness?.[1], bytesToHex(user.publicKey), "the public key comes from the raw transaction");
  assert.equal(tx.vout.find((o) => o.scriptpubkey_type === "op_return")?.scriptpubkey.slice(0, 2), "6a");
  const event = eventFromTx(tx, desk.address, "test", 1);
  assert.equal(event.sender, user.address);
  assert.equal(event.senderPubkey, bytesToHex(user.publicKey));
  assert.equal(event.memo, "NOTUS1 buy CAT");
  assert.equal(event.valueLit, 200_000n);
  assert.equal(event.height, 3_600_100);
  assert.equal(calls.filter((c) => c.endsWith(`/tx/${built.txid}`)).length, 1);
  await bb.addressTxsChain(desk.address);
  assert.equal(calls.filter((c) => c.endsWith(`/tx/${built.txid}`)).length, 1, "a mined transaction is translated once");
  assert.deepEqual(await bb.addressTxsChain(desk.address, built.txid), [], "nothing older than the last one");

  const mem = await bb.addressTxsMempool(desk.address);
  assert.equal(mem.length, 1);
  assert.equal(mem[0].status.confirmed, false);
  const p = pendingFromTx(mem[0], desk.address, "test", 5);
  assert.deepEqual(p && { ...p, valueLit: p.valueLit.toString() }, { txid: pendingBuilt.txid, sender: user.address, valueLit: "10000", memo: "NOTUS1 claim", seen: 5 });

  assert.deepEqual(await bb.utxos(desk.address), [
    { txid: built.txid, vout: 0, value: 200_000n, confirmed: true },
    { txid: pendingBuilt.txid, vout: 0, value: 10_000n, confirmed: false },
  ]);
  assert.deepEqual(await bb.blockTxids("ab".repeat(32)), ["11".repeat(32), built.txid]);
  assert.equal(await bb.feeRate(), 3n, "0.000025 LTC/kB is 2.5 lit/vB, rounded up");
  assert.equal((await bb.txStatus(built.txid)).block_height, 3_600_100);
  assert.equal(scriptType(user.script ? bytesToHex(user.script) : ""), "v0_p2wpkh");
});

test("blockbook: pages walk like Esplora's, broadcast answers and errors translate", async () => {
  const txs = Array.from({ length: 60 }, (_, i) => ({ ...blockbookTx(built, true), txid: i.toString(16).padStart(64, "0"), blockHeight: 3_600_200 - i }));
  const page = (n: number) => json({ page: n, totalPages: 2, transactions: txs.slice((n - 1) * 50, n * 50) });
  const posted: string[] = [];
  fakeFetch({
    [`https://bb/api/v2/address/${desk.address}?details=txs&pageSize=50&page=1`]: page(1),
    [`https://bb/api/v2/address/${desk.address}?details=txs&pageSize=50&page=2`]: page(2),
    "https://bb/api/v2/sendtx/": (init) => {
      posted.push(String(init?.body));
      return posted.length === 1
        ? new Response(JSON.stringify({ result: built.txid }))
        : new Response(JSON.stringify({ error: { message: "Transaction already in block chain" } }), { status: 400 });
    },
    "https://bb/api/v2/estimatefee/2": json({ result: "-1" }),
  });
  const bb = new Blockbook("https://bb/api/v2", "test");
  const first = await bb.addressTxsChain(desk.address);
  assert.equal(first.length, 25);
  const second = await bb.addressTxsChain(desk.address, first[24].txid);
  assert.equal(second.length, 25);
  assert.equal(second[0].txid, txs[25].txid);
  const third = await bb.addressTxsChain(desk.address, second[24].txid);
  assert.equal(third.length, 10, "60 in all: the last page is short, which ends the walk");
  assert.equal(third[0].txid, txs[50].txid, "across Blockbook's page boundary");
  const fresh = new Blockbook("https://bb/api/v2", "test");
  assert.equal((await fresh.addressTxsChain(desk.address, txs[30].txid))[0].txid, txs[31].txid, "an unknown cursor is searched for");
  assert.deepEqual(await fresh.addressTxsChain(desk.address, "ff".repeat(32)), [], "a cursor that is not in the history");

  assert.equal(await bb.broadcast(built.hex), built.txid);
  assert.equal(await bb.broadcast(built.hex), built.txid, "already relayed: still a success");
  assert.deepEqual(posted, [built.hex, built.hex]);
  assert.equal(await bb.feeRate(), 10n, "no estimate: the default");
  await assert.rejects(new Esplora("https://nowhere/api").tipHeight(), /blocks\/tip\/height: fetch failed/);
});
