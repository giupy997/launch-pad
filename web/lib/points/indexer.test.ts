// A chain's indexer end to end against a fake node: logs encoded as the pad
// emits them, passes that advance, a graduation, an invite, a restart that
// resumes from disk, a stretch the node refuses that is read next time, a
// crash between the events and the checkpoint that must count nothing twice,
// the coins' transfers counted into holders and one coin's trades packed for
// the site's feed.
//   node --test --experimental-strip-types web/lib/points/indexer.test.ts
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, pad as padHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PointsChain } from "./chains.ts";
import { padEventsAbi, TRANSFER_TOPIC, type RpcLog } from "./decode.ts";
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
const POOL = "0x0000000000000000000000000000000000900001" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
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

type Emitted = { block: bigint; logIndex: number; topics: `0x${string}`[]; data: `0x${string}`; address: `0x${string}` };
const emitted: Emitted[] = [];
const emit = (block: bigint, topics: `0x${string}`[], data: `0x${string}`, address: `0x${string}` = PAD) => {
  emitted.push({ block, logIndex: emitted.filter((e) => e.block === block).length, topics, data, address });
};
/** a coin's Transfer, logged by the coin itself */
const transfer = (block: bigint, token: `0x${string}`, from: `0x${string}`, to: `0x${string}`, value: bigint) =>
  emit(block, [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)], encodeAbiParameters([{ type: "uint256" }], [value]), token);
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
const freezeAnnounced = (block: bigint, atBlock: bigint) =>
  emit(block, [encodeEventTopics({ abi: padEventsAbi, eventName: "FreezeAnnounced" })[0]], encodeAbiParameters([{ type: "uint256" }], [atBlock]));
const freezeCancelled = (block: bigint) => emit(block, [encodeEventTopics({ abi: padEventsAbi, eventName: "FreezeCancelled" })[0]], "0x");

let head = 1_000n;
let refuse: ((lo: bigint, hi: bigint) => boolean) | null = null;
const transport: Transport = async (_url, method, params) => {
  if (method === "eth_blockNumber") return hex(head);
  if (method === "eth_getBlockByNumber") return { timestamp: hex(1_700_000_000n + BigInt((params as [string])[0])) };
  if (method === "eth_getCode") {
    const a = (params as [string])[0].toLowerCase();
    return a === PAD.toLowerCase() || a === POOL ? "0x6080" : "0x"; // the pad and the pool are contracts, the wallets are not
  }
  if (method === "eth_getLogs") {
    const p = (params as [{ fromBlock: string; toBlock: string; address: string | string[] }])[0];
    const lo = BigInt(p.fromBlock);
    const hi = BigInt(p.toBlock);
    if (refuse?.(lo, hi)) throw new RpcError("internal error");
    const addresses = (Array.isArray(p.address) ? p.address : [p.address]).map((a) => a.toLowerCase());
    return emitted
      .filter((e) => e.block >= lo && e.block <= hi && addresses.includes(e.address.toLowerCase()))
      .map(
        (e): RpcLog => ({
          address: e.address,
          topics: e.topics,
          data: e.data,
          blockNumber: hex(e.block),
          transactionHash: `0x${(e.block * 1_000n + BigInt(e.logIndex)).toString(16).padStart(64, "0")}`, // one per event, the same on every read, as on a chain
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
  // carol: 2,000 creator. alice: 60 trade + 30 holder + 100 early (twice her 60, capped) = 190. bob: 10 + 5 holder + 20 early = 35.
  assert.deepEqual(
    board.map((row) => [row.wallet, row.points]),
    [
      [carol.address.toLowerCase(), 2000],
      [alice.address.toLowerCase(), 190],
      [bob.address.toLowerCase(), 35],
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

test("a crash between the events and the checkpoint counts nothing twice on the next start", async () => {
  const store = new Store(join(dir, "crash"));
  const nodes = new Nodes(chain.rpcs, chain.chunk, { transport, sleep: async () => {} });
  const ix = new ChainIndexer(chain, nodes, store);
  await ix.pass(); // everything emitted so far
  const trades = ix.trades.length;
  const board = ix.leaderboard();
  const onDisk = store.loadEvents().length;
  assert.ok(trades > 0 && onDisk > 0);

  // the crash: the events reached the disk, the checkpoint did not
  store.writeMeta({ last: chain.deployBlock - 1n, rulesVersion: 0, chunk: chain.chunk });
  const again = new ChainIndexer(chain, nodes, store);
  assert.equal(again.last, chain.deployBlock - 1n);
  assert.equal(again.trades.length, trades); // the file's events, once
  const r = await again.pass(); // the same logs read again
  assert.ok(r && r.events === 0);
  assert.equal(again.trades.length, trades);
  assert.deepEqual(again.leaderboard(), board);
  assert.equal(store.loadEvents().length, onDisk); // and written again to nobody
  assert.equal(again.last, ix.last);
});

test("a freeze announced ends the season there; withdrawn before it lands, the season runs on", async () => {
  const store = new Store(join(dir, "freeze"));
  const nodes = new Nodes(chain.rpcs, chain.chunk, { transport, sleep: async () => {} });
  const ix = new ChainIndexer(chain, nodes, store);
  await ix.pass(); // everything emitted so far
  const alicePoints = () => ix.leaderboard().find((r) => r.wallet === alice.address.toLowerCase())?.points ?? 0;
  const before = alicePoints();

  freezeAnnounced(1_410n, 1_500n); // the pad stands still from block 1,500: the season ends there
  head = 1_440n; // lag 10: this pass reads to 1,430, the announcement included
  await ix.pass();
  assert.equal(ix.effectiveSeason()?.end, 1_500n);

  freezeCancelled(1_450n); // withdrawn before it landed
  bought(1_520n, COIN, alice.address, 1, 10n * LTC); // past the block once announced: the freeze never came
  head = 1_600n;
  await ix.pass();
  assert.equal(ix.effectiveSeason()?.end, null);
  assert.ok(alicePoints() > before);

  // a restart replays the file in order and lands on the same answer
  const again = new ChainIndexer(chain, nodes, store);
  assert.equal(again.effectiveSeason()?.end, null);
  assert.equal(again.leaderboard().find((r) => r.wallet === alice.address.toLowerCase())?.points, alicePoints());
});

test("the coins' transfers count the holders; one coin's trades come packed for the site's feed; a service that never read transfers backfills them", async () => {
  const store = new Store(join(dir, "holders"));
  const nodes = new Nodes(chain.rpcs, chain.chunk, { transport, sleep: async () => {} });
  const ix = new ChainIndexer(chain, nodes, store);
  // the coin's life as its token logs it: minted to the pad, paid out to alice and bob on
  // their buys, half of alice's back to the pad on her sell, a slice to the pool at graduation
  transfer(1_010n, COIN, ZERO, PAD, 1_000_000_000n * LTC);
  transfer(1_020n, COIN, PAD, alice.address, 800_000_000n * LTC);
  transfer(1_021n, COIN, PAD, bob.address, 10n * LTC);
  transfer(1_030n, COIN, alice.address, PAD, 400_000_000n * LTC);
  transfer(1_040n, COIN, PAD, POOL, 190_000_000n * LTC);
  await ix.pass(); // the pad's events, then the coins' transfers up to the same block
  assert.equal(ix.transfersLast, ix.last);

  const h = await ix.coinHolders(COIN);
  assert.equal(h.partial, false);
  assert.equal(h.holders, 2); // alice and bob: the pad and the pool hold coins but are contracts
  assert.deepEqual(
    h.top.map((t) => [t.a, t.c]),
    [
      [PAD.toLowerCase(), true],
      [alice.address.toLowerCase(), false],
      [POOL, true],
      [bob.address.toLowerCase(), false],
    ]
  );
  assert.equal(h.top[1].b, (400_000_000n * LTC).toString());
  assert.equal(h.created, "1010");
  assert.equal(h.graduated, "1040");
  assert.equal(h.launched, 1_700_000_000 + 1_010); // the creation block's time
  assert.equal(h.last, ix.last.toString());

  const t = await ix.coinTrades(COIN);
  assert.equal(t.created, "1010");
  assert.equal(t.graduated, "1040");
  assert.ok(t.trades.length >= 3);
  const [type, trader, eth, tokens, block, , timestamp, token, venue] = t.trades[0];
  assert.deepEqual([type, trader, eth, tokens, block, timestamp, token, venue], ["buy", alice.address.toLowerCase(), (2n * LTC).toString(), (800_000_000n * LTC).toString(), "1020", 1_700_000_000 + 1_020, COIN, "curve"]);
  for (let i = 1; i < t.trades.length; i++) assert.ok(BigInt(t.trades[i][4]) >= BigInt(t.trades[i - 1][4])); // oldest first

  // a restart: the balances from disk, the transfers left where they were
  const again = new ChainIndexer(chain, nodes, store);
  assert.equal(again.transfersLast, ix.transfersLast);
  assert.equal((await again.coinHolders(COIN)).holders, 2);

  // a service that ran before transfers were read (no checkpoint for them): partial until its
  // next pass, which reads them from the deploy block and counts nothing twice
  const onDisk = store.loadEvents().length;
  store.writeMeta({ last: ix.last, rulesVersion: 0, chunk: chain.chunk });
  const old = new ChainIndexer(chain, nodes, store);
  assert.equal(old.transfersLast, chain.deployBlock - 1n);
  assert.equal((await old.coinHolders(COIN)).partial, true);
  await old.pass(); // nothing mined since: the transfers alone
  assert.equal(old.transfersLast, old.last);
  assert.equal((await old.coinHolders(COIN)).partial, false);
  assert.equal(store.loadEvents().length, onDisk);
  assert.equal(store.loadEvents().filter((e) => e.kind === "transfer").length, 5);

  // a head far ahead of what is indexed (a backfill in progress): the count is partial until the passes catch up
  head = 10_000n;
  await old.pass();
  assert.ok(old.last < head - chain.lag);
  assert.equal((await old.coinHolders(COIN)).partial, true);
  while (old.last < head - chain.lag) await old.pass();
  assert.equal((await old.coinHolders(COIN)).partial, false);
});
