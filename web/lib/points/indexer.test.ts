// A chain's indexer end to end against a fake node: logs encoded as the pad
// emits them, passes that advance, a graduation, an invite, a restart that
// resumes from disk, a stretch the node refuses that is read next time.
//   node --test --experimental-strip-types web/lib/points/indexer.test.ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, pad as padHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PointsChain } from "./chains.ts";
import { padEventsAbi, type RpcLog } from "./decode.ts";
import { ChainIndexer } from "./indexer.ts";
import { referralMessage } from "./referral.ts";
import { Nodes, RpcError, type Transport } from "./scan.ts";
import { Store } from "./store.ts";

const PAD = "0x4D3C63F873bc2aC79E529C8003321d60643a4025" as const;
const LTC = 10n ** 18n;
const alice = privateKeyToAccount(`0x${"a1".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"b2".repeat(32)}`);
const carol = privateKeyToAccount(`0x${"c3".repeat(32)}`);
const COIN = "0x00000000000000000000000000000000000c0001" as const;
const hex = (n: bigint) => `0x${n.toString(16)}` as `0x${string}`;
const addrTopic = (a: string) => padHex(a as `0x${string}`, { size: 32 });

const chain: PointsChain = {
  key: "fake",
  chainId: 4441,
  name: "fake chain",
  pad: PAD,
  deployBlock: 1_000n,
  rpcs: ["node"],
  quoteDecimals: 18,
  quoteSymbol: "zkLTC",
  blockSeconds: 1,
  chunk: 100n,
  lag: 10n,
  hidden: [],
  season: { number: 0, name: "Season 0", start: 1_000n, end: null, rehearsal: true },
  explorer: "",
};

type Emitted = { block: bigint; logIndex: number; topics: `0x${string}`[]; data: `0x${string}` };
const emitted: Emitted[] = [];
let txn = 0;
const emit = (block: bigint, topics: `0x${string}`[], data: `0x${string}`) => {
  emitted.push({ block, logIndex: emitted.filter((e) => e.block === block).length, topics, data });
};
const created = (block: bigint, token: `0x${string}`, creator: `0x${string}`) =>
  emit(block, [encodeEventTopics({ abi: padEventsAbi, eventName: "TokenCreated" })[0], addrTopic(token), addrTopic(creator)], encodeAbiParameters([{ type: "string" }, { type: "string" }, { type: "bool" }], ["Coin", "COIN", false]));
const bought = (block: bigint, token: `0x${string}`, buyer: `0x${string}`, ltc: number, tokens: bigint) =>
  emit(
    block,
    [encodeEventTopics({ abi: padEventsAbi, eventName: "Bought" })[0], addrTopic(token), addrTopic(buyer)],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [BigInt(Math.round(ltc * 1e6)) * (LTC / 10n ** 6n), tokens, 0n])
  );
const sold = (block: bigint, token: `0x${string}`, seller: `0x${string}`, ltc: number, tokens: bigint) =>
  emit(
    block,
    [encodeEventTopics({ abi: padEventsAbi, eventName: "Sold" })[0], addrTopic(token), addrTopic(seller)],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [tokens, BigInt(Math.round(ltc * 1e6)) * (LTC / 10n ** 6n), 0n])
  );
const graduated = (block: bigint, token: `0x${string}`) =>
  emit(block, [encodeEventTopics({ abi: padEventsAbi, eventName: "Graduated" })[0], addrTopic(token)], encodeAbiParameters([{ type: "uint256" }], [192n * LTC]));

let head = 1_000n;
let refuse: ((lo: bigint, hi: bigint) => boolean) | null = null;
const transport: Transport = async (_url, method, params) => {
  if (method === "eth_blockNumber") return hex(head);
  if (method === "eth_getLogs") {
    const p = (params as [{ fromBlock: string; toBlock: string; address: string }])[0];
    const lo = BigInt(p.fromBlock);
    const hi = BigInt(p.toBlock);
    if (refuse?.(lo, hi)) throw new RpcError("internal error");
    return emitted
      .filter((e) => e.block >= lo && e.block <= hi)
      .map(
        (e): RpcLog => ({
          address: PAD,
          topics: e.topics,
          data: e.data,
          blockNumber: hex(e.block),
          transactionHash: `0x${(++txn).toString(16).padStart(64, "0")}`,
          logIndex: hex(BigInt(e.logIndex)),
        })
      );
  }
  throw new RpcError(`unexpected ${method}`);
};

const dir = mkdtempSync(join(tmpdir(), "notus-points-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("passes read the pad's life and score it; a restart resumes from disk", async () => {
  created(1_010n, COIN, carol.address);
  bought(1_020n, COIN, alice.address, 2, 800_000_000n * LTC); // alice takes the whole curve, 2 LTC (the fake pad's price)
  bought(1_021n, COIN, bob.address, 0.5, 10n * LTC);
  sold(1_030n, COIN, alice.address, 1, 400_000_000n * LTC);
  graduated(1_040n, COIN);
  head = 1_060n; // lag 10: indexable to 1,050

  const nodes = new Nodes(chain.rpcs, chain.chunk, { transport, sleep: async () => {} });
  const ix = new ChainIndexer(chain, nodes, new Store(join(dir, "fake")), { now: () => 1_700_000_000_000 });
  const r = await ix.pass();
  assert.ok(r);
  assert.equal(r.from, 1_000n);
  assert.equal(r.to, 1_050n);
  assert.equal(ix.trades.length, 3);
  assert.equal(ix.coins.get(COIN)?.graduatedBlock, 1_040n);

  const board = ix.leaderboard();
  // carol: 2,000 creator. alice: 60 trade + 30 holder + 100 early = 190. bob: 10 + 5 holder + 100 early = 115.
  assert.deepEqual(
    board.map((row) => [row.wallet, row.points]),
    [
      [carol.address.toLowerCase(), 2000],
      [alice.address.toLowerCase(), 190],
      [bob.address.toLowerCase(), 115],
    ]
  );
  const a = ix.wallet(alice.address);
  assert.equal(a.rank, 2);
  assert.equal(a.trades, 2);
  assert.equal(a.volume, (3n * LTC).toString());
  assert.deepEqual(
    a.byKind.map((k) => [k.kind, k.points]),
    [
      ["trade", 60],
      ["grad_holder", 30],
      ["early", 100],
    ]
  );

  // nothing new: a pass is a no-op
  assert.equal(await ix.pass(), null);

  // a restart: the same facts from disk, the same board, resumes at the same block
  const again = new ChainIndexer(chain, nodes, new Store(join(dir, "fake")));
  assert.equal(again.last, 1_050n);
  assert.equal(again.trades.length, 3);
  assert.deepEqual(again.leaderboard(), board);
});

test("an invite binds once, with the invitee's signature, and pays from then on", async () => {
  const nodes = new Nodes(chain.rpcs, chain.chunk, { transport, sleep: async () => {} });
  const ix = new ChainIndexer(chain, nodes, new Store(join(dir, "fake")), { now: () => 1_700_000_000_000 });
  const message = referralMessage(carol.address, "fake", 0);
  const sig = await bob.signMessage({ message });
  const bad = await ix.bindReferral({ invitee: bob.address, inviter: carol.address, signature: await alice.signMessage({ message }) });
  assert.equal(bad.status, 400);
  const ok = await ix.bindReferral({ invitee: bob.address, inviter: carol.address, signature: sig });
  assert.equal(ok.status, 201);
  const dup = await ix.bindReferral({ invitee: bob.address, inviter: alice.address, signature: await bob.signMessage({ message: referralMessage(alice.address, "fake", 0) }) });
  assert.equal(dup.status, 409);
  assert.equal(ix.wallet(bob.address).inviter, carol.address.toLowerCase());

  // bob trades after the binding: carol gets 10%, bob +5%
  head = 1_200n;
  bought(1_100n, COIN, bob.address, 4, 10n * LTC);
  await ix.pass();
  const bobView = ix.wallet(bob.address);
  assert.ok(bobView.byKind.some((k) => k.kind === "ref_invitee" && k.points === 4)); // 5% of 80
  const carolView = ix.wallet(carol.address);
  assert.ok(carolView.byKind.some((k) => k.kind === "ref_inviter" && k.points === 8)); // 10% of 80
  assert.deepEqual(carolView.invitees, [{ wallet: bob.address.toLowerCase(), points: 8 }]);
});

test("a stretch the node refuses is left for the next pass, never skipped", async () => {
  const nodes = new Nodes(chain.rpcs, chain.chunk, { transport, sleep: async () => {} });
  const ix = new ChainIndexer(chain, nodes, new Store(join(dir, "fake")));
  const before = ix.last;
  bought(1_250n, COIN, alice.address, 1, 10n * LTC);
  head = 1_400n;
  refuse = (lo) => lo === before + 1n; // the first range of the pass
  await assert.rejects(ix.pass());
  assert.equal(ix.last, before);
  refuse = (lo) => lo > before + 100n; // now only the later ranges
  const r = await ix.pass();
  assert.ok(r && r.to === before + 100n);
  refuse = null;
  const r2 = await ix.pass();
  assert.ok(r2 && r2.to === 1_390n);
  assert.equal(ix.trades.filter((t) => t.block === 1_250n).length, 1);
});
