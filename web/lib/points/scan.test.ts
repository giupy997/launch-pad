// The log reader against fakes of the real nodes: mainnet.base.org's 2,000
// cap with its exact message, publicnode's "archive" refusal on old blocks,
// a node that throttles then eases, one that is dead.
//   node --test --experimental-strip-types web/lib/points/scan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { capNamed, isRangeError, isThrottle, Nodes, RpcError, stretches, type Transport } from "./scan.ts";
import type { RpcLog } from "./decode.ts";

const TO = 52_081_799n;
const FROM = 52_045_689n;
const PAD = ("0x" + "1".repeat(40)) as `0x${string}`;
const hex = (n: bigint) => `0x${n.toString(16)}`;

type Behaviour = (lo: bigint, hi: bigint, n: number) => void; // throws to refuse
/** a JSON-RPC transport whose nodes behave as told, counting the calls to each */
function fakeTransport(behaviours: Record<string, Behaviour>, calls: Record<string, number>): Transport {
  const counts = new Map<string, number>();
  return async (url, method, params) => {
    calls[url] = (calls[url] ?? 0) + 1;
    const n = (counts.get(url) ?? 0) + 1;
    counts.set(url, n);
    if (method === "eth_blockNumber") {
      behaviours[url](0n, 0n, n);
      return hex(TO + 60n);
    }
    const p = (params as [{ fromBlock: string; toBlock: string }])[0];
    const lo = BigInt(p.fromBlock);
    const hi = BigInt(p.toBlock);
    behaviours[url](lo, hi, n);
    const out: RpcLog[] = [];
    for (let bn = ((lo + 999n) / 1000n) * 1000n; bn <= hi; bn += 1000n)
      out.push({ address: PAD, topics: [], data: "0x", blockNumber: hex(bn) as `0x${string}`, transactionHash: "0x00", logIndex: "0x0" });
    return out;
  };
}
function fakeNodes(behaviours: Record<string, Behaviour>, calls: Record<string, number>, chunk: bigint): Nodes {
  return new Nodes(Object.keys(behaviours), chunk, { transport: fakeTransport(behaviours, calls), sleep: async () => {} });
}
const rangeErr = () => new RpcError('{"code":-32614,"message":"eth_getLogs is limited to a 2,000 range"}', -32614, 413);
const archiveErr = () => new RpcError("Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode", -32602, 403);
const throttleErr = () => new RpcError("http 429", undefined, 429);
const deadErr = () => new RpcError("fetch failed: ECONNREFUSED");
const baseLike =
  (extra?: Behaviour): Behaviour =>
  (lo, hi, n) => {
    if (hi - lo + 1n > 2000n) throw rangeErr();
    extra?.(lo, hi, n);
  };
const publicLike: Behaviour = (lo, hi) => {
  if (lo < TO - 20_000n) throw archiveErr();
  if (hi - lo + 1n > 50_000n) throw rangeErr();
};
const dead: Behaviour = () => {
  throw deadErr();
};
const expected = (from: bigint, to: bigint) => {
  let c = 0;
  for (let bn = ((from + 999n) / 1000n) * 1000n; bn <= to; bn += 1000n) c++;
  return c;
};

test("the real errors are told apart", () => {
  assert.ok(isRangeError(rangeErr()) && !isThrottle(rangeErr()));
  assert.equal(capNamed(rangeErr()), 2000n);
  assert.ok(!isRangeError(archiveErr()) && !isThrottle(archiveErr()));
  assert.ok(isThrottle(throttleErr()) && !isRangeError(throttleErr()));
  assert.deepEqual(
    stretches([
      { lo: 10n, hi: 19n },
      { lo: 30n, hi: 39n },
      { lo: 20n, hi: 29n },
      { lo: 50n, hi: 59n },
    ]),
    [
      { lo: 10n, hi: 39n },
      { lo: 50n, hi: 59n },
    ]
  );
});

test("Base as configured: everything through the first node, 1,999 at a time", async () => {
  const calls: Record<string, number> = {};
  const nodes = fakeNodes({ base: baseLike(), public: publicLike, dead }, calls, 1_999n);
  const r = await nodes.getLogs({ address: PAD, topics: [] }, FROM, TO);
  assert.equal(r.logs.length, expected(FROM, TO));
  assert.equal(r.failed.length, 0);
  assert.equal(calls.base, 19);
  assert.equal(calls.public, undefined);
});

test("a guessed 9,000 chunk: the cap is read off the refusal and sticks", async () => {
  const calls: Record<string, number> = {};
  const learned: bigint[] = [];
  const nodes = new Nodes(["base", "public", "dead"], 9_000n, {
    transport: fakeTransport({ base: baseLike(), public: publicLike, dead }, calls),
    sleep: async () => {},
    onChunk: (s) => learned.push(s),
  });
  const r = await nodes.getLogs({ address: PAD, topics: [] }, FROM, TO);
  assert.equal(r.logs.length, expected(FROM, TO));
  assert.equal(r.failed.length, 0);
  assert.equal(nodes.chunk, 1_999n);
  assert.deepEqual(learned, [1_999n]);
});

test("the first node throttles for a moment: the others cover, then it is back", async () => {
  let t = 0;
  const calls: Record<string, number> = {};
  const transport = fakeTransport(
    {
      base: baseLike((lo, hi, n) => {
        if (n <= 3) throw throttleErr();
      }),
      public: publicLike,
      dead,
    },
    calls
  );
  // a stubbed clock: sleeping advances it, and the cooldown is shorter than the first backoff
  const nodes = new Nodes(["base", "public", "dead"], 1_999n, {
    transport,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    throttleCooldownMs: 300,
  });
  const r = await nodes.getLogs({ address: PAD, topics: [] }, FROM, TO);
  assert.equal(r.logs.length, expected(FROM, TO));
  assert.equal(r.failed.length, 0);
  assert.ok((calls.public ?? 0) > 0, "the second node covered while the first sat out");
});

test("old blocks nobody serves are reported, the rest comes back", async () => {
  const calls: Record<string, number> = {};
  const nodes = fakeNodes(
    {
      base: baseLike((lo) => {
        if (lo < TO - 10_000n) throw deadErr();
      }),
      public: publicLike,
      dead,
    },
    calls,
    1_999n
  );
  const r = await nodes.getLogs({ address: PAD, topics: [] }, FROM, TO);
  assert.ok(r.failed.length > 0);
  const got = stretches(r.ok);
  assert.equal(got[got.length - 1].hi, TO);
  assert.ok(got[got.length - 1].lo >= TO - 20_000n);
});

test("nothing answers: every range is reported, none thrown", async () => {
  const calls: Record<string, number> = {};
  const nodes = fakeNodes({ a: dead, b: dead }, calls, 1_999n);
  const r = await nodes.getLogs({ address: PAD, topics: [] }, FROM, FROM + 5_000n);
  assert.equal(r.ok.length, 0);
  assert.equal(r.failed.length, 3);
  await assert.rejects(nodes.blockNumber());
});
