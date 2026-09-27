// The explorer client's fallback: several endpoints, tried in order when one
// is down, never one that serves the other chain. Run with:
//   node --test --experimental-strip-types lib/litecoin/esplora.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import { Esplora, GENESIS } from "./esplora.ts";
import { buildTx, walletFromSecret, type Utxo } from "./tx.ts";

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
const cloudflare = (status: number) => text(`<!DOCTYPE html><title>${status}</title>`, status);

test("falls back to the next endpoint on a 5xx or an unreachable one, never on a 4xx", async () => {
  const calls = fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.main),
    "https://b/api/block-height/0": text(GENESIS.main),
    "https://a/api/blocks/tip/height": cloudflare(522),
    "https://b/api/blocks/tip/height": text("3185373"),
    "https://a/api/tx/aa": text('{"error":"no"}', 404),
    "https://b/api/tx/aa": text('{"txid":"aa"}'),
    "https://b/api/address/x/utxo": text("[]"),
  });
  const api = new Esplora("https://a/api, https://b/api/", "main");
  assert.deepEqual(api.bases, ["https://a/api", "https://b/api"]);
  assert.equal(await api.tipHeight(), 3185373, "a answered 522: b's answer");
  await assert.rejects(api.tx("aa"), /tx\/aa: HTTP 404/, "a 4xx is an answer, not an outage");
  assert.ok(!calls.includes("https://b/api/tx/aa"), "b was not asked");
  assert.deepEqual(await api.utxos("x"), [], "a unreachable (no route at all): b");
  assert.equal(calls.filter((c) => c.endsWith("/block-height/0")).length, 2, "each endpoint's chain is checked once");
});

test("a fallback that serves the other chain is skipped, one that cannot say is used", async () => {
  fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.main),
    "https://a/api/blocks/tip/height": cloudflare(524),
    "https://wrong/api/block-height/0": text(GENESIS.test),
    "https://wrong/api/blocks/tip/height": text("4902108"),
    "https://mute/api/block-height/0": text("not found", 404),
    "https://mute/api/blocks/tip/height": text("3185380"),
  });
  const api = new Esplora("https://a/api,https://wrong/api", "main");
  await assert.rejects(api.tipHeight(), /HTTP 524/, "the testnet explorer is never used for the mainnet desk");
  const api2 = new Esplora("https://a/api,https://mute/api", "main");
  assert.equal(await api2.tipHeight(), 3185380);
  const single = new Esplora("https://wrong/api", "main");
  assert.equal(await single.tipHeight(), 4902108, "a single endpoint is trusted as configured, no probe");
});

test("the last endpoint's 5xx is reported as is; a timeout counts as unreachable", async () => {
  fakeFetch({
    "https://a/api/blocks/tip/height": cloudflare(520),
  });
  const api = new Esplora("https://a/api");
  await assert.rejects(api.tipHeight(), /blocks\/tip\/height: HTTP 520/);
  const calls = fakeFetch({
    "https://a/api/block-height/0": text(GENESIS.test),
    "https://b/api/block-height/0": text(GENESIS.test),
    // never answers: only the client's own timeout ends the request
    "https://a/api/v1/fees/recommended": (init) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    "https://b/api/v1/fees/recommended": text('{"halfHourFee":7}'),
  });
  const slow = new Esplora("https://a/api,https://b/api", "test", 50);
  const keep = setInterval(() => {}, 1000); // a real socket would keep the loop alive; the fake has none
  const t = Date.now();
  try {
    assert.equal(await slow.feeRate(), 7n, "a timed out: b's answer");
  } finally {
    clearInterval(keep);
  }
  assert.ok(Date.now() - t < 5_000);
  assert.ok(calls.includes("https://b/api/v1/fees/recommended"));
});

test("broadcast: relayed by an endpoint that then failed counts as sent", async () => {
  const secret = bytesToHex(sha256(utf8ToBytes("notus-litecoin-test-user")));
  const desk = walletFromSecret(bytesToHex(sha256(utf8ToBytes("notus-litecoin-test-desk"))), "test");
  const utxo: Utxo = { txid: "1".padStart(64, "0"), vout: 1, value: 1_000_000n, confirmed: true };
  const built = buildTx({ network: "test", secret, utxos: [utxo], payments: [{ address: desk.address, lit: 100_000n }], memo: "NOTUS1 fund", feeRate: 10n });
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
  const api = new Esplora("https://a/api,https://b/api", "test");
  assert.equal(await api.broadcast(built.hex), built.txid);
  assert.deepEqual(bodies, [built.hex]);
  fakeFetch({ "https://a/api/tx": text("sendrawtransaction RPC error: min relay fee not met", 400) });
  await assert.rejects(new Esplora("https://a/api", "test").broadcast(built.hex), /broadcast rejected: .*min relay fee/);
});
