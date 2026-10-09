// The pool swaps a scan names as the protocol's own, against a fake node that
// answers eth_getLogs with made-up Swap logs and eth_call with the pad's
// migrator: a harvest (the migrator sells to itself), a buyback (it buys for
// the pad), a nudge (it buys for itself: a plain buy, no name), a trader's
// swap through the router; the migrator asked of the pad once and kept, or
// taken from the ref; the packed form carrying the kind, and tolerating the
// form before it.
//   node --test --experimental-strip-types web/lib/trades/scan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { encodeAbiParameters, encodeEventTopics, numberToHex, parseAbiItem, toFunctionSelector } from "viem";
import { packTrades, scanTrades, unpackTrades, type PackedTrade, type PoolRef, type ScanTarget, type Trade } from "./scan.ts";

const PAD = "0x000000000000000000000000000000000000ad00" as const;
const MIGRATOR = "0x00000000000000000000000000000000000000a1" as const;
const ROUTER = "0x00000000000000000000000000000000000000b2" as const;
const WALLET = "0x00000000000000000000000000000000000000c3" as const;
const TOKEN = "0x0000000000000000000000000000000000000c01" as const;
const PAIR = "0x0000000000000000000000000000000000000fa1" as const;
const QUOTE = 10n ** 8n; // a cbLTC
const COIN = 10n ** 18n;

const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
);
const graduatedVia = toFunctionSelector("graduatedVia(address)");

type Swap = { sender: `0x${string}`; to: `0x${string}`; tokensIn: bigint; quoteIn: bigint; tokensOut: bigint; quoteOut: bigint; block: number; index: number };

/** a Swap log of the pair, the coin as token0 */
function swapLog(s: Swap) {
  const [sender, to] = [s.sender, s.to];
  return {
    address: PAIR,
    topics: encodeEventTopics({ abi: [swapEvent], args: { sender, to } }),
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [s.tokensIn, s.quoteIn, s.tokensOut, s.quoteOut]
    ),
    blockNumber: numberToHex(s.block),
    transactionHash: `0x${(s.block * 100 + s.index).toString(16).padStart(64, "0")}`,
    logIndex: numberToHex(s.index),
  };
}

/** a node that holds these swaps of the pair, no trades of the pad, and the pad's answer to graduatedVia */
function fakeNode(swaps: Swap[], calls: { getLogs: number; call: number }): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      let result: unknown;
      if (method === "eth_getLogs") {
        calls.getLogs++;
        const f = params[0] as { address: string; fromBlock: string; toBlock: string };
        const lo = Number(BigInt(f.fromBlock));
        const hi = Number(BigInt(f.toBlock));
        result = f.address.toLowerCase() === PAIR.toLowerCase() ? swaps.filter((s) => s.block >= lo && s.block <= hi).map(swapLog) : [];
      } else if (method === "eth_call") {
        calls.call++;
        const c = params[0] as { to: string; data: string };
        assert.equal(c.to.toLowerCase(), PAD.toLowerCase());
        assert.equal(c.data.slice(0, 10), graduatedVia);
        assert.equal(c.data.slice(10), TOKEN.slice(2).toLowerCase().padStart(64, "0"));
        result = `0x${MIGRATOR.slice(2).toLowerCase().padStart(64, "0")}`;
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method} here` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${a.port}` });
    });
  });
}

const swaps: Swap[] = [
  // a wallet buys through the router
  { sender: ROUTER, to: WALLET, tokensIn: 0n, quoteIn: QUOTE, tokensOut: 1000n * COIN, quoteOut: 0n, block: 3, index: 2 },
  // a harvest: the migrator sells the fee buckets to itself
  { sender: MIGRATOR, to: MIGRATOR, tokensIn: 50n * COIN, quoteIn: 0n, tokensOut: 0n, quoteOut: QUOTE / 20n, block: 4, index: 7 },
  // a buyback: the migrator buys with the burn pot, the coins go to the pad
  { sender: MIGRATOR, to: PAD, tokensIn: 0n, quoteIn: QUOTE / 10n, tokensOut: 90n * COIN, quoteOut: 0n, block: 5, index: 1 },
  // a nudge at seeding: the migrator buys for itself; a buy, not named
  { sender: MIGRATOR, to: MIGRATOR, tokensIn: 0n, quoteIn: QUOTE / 100n, tokensOut: 9n * COIN, quoteOut: 0n, block: 6, index: 3 },
  // a wallet sells through the router
  { sender: ROUTER, to: WALLET, tokensIn: 200n * COIN, quoteIn: 0n, tokensOut: 0n, quoteOut: QUOTE / 5n, block: 7, index: 4 },
];

let chainId = 990_000; // a fresh one per test: the scan keeps its node sets and migrators per chain
async function withNode<T>(fn: (t: ScanTarget, calls: { getLogs: number; call: number }) => Promise<T>): Promise<T> {
  const calls = { getLogs: 0, call: 0 };
  const { server, url } = await fakeNode(swaps, calls);
  try {
    return await fn({ chainId: ++chainId, urls: [url], chunk: 1_000n }, calls);
  } finally {
    server.close();
  }
}

test("the migrator's own swaps are named, a trader's and a nudge are not", async () => {
  await withNode(async (t, calls) => {
    const pool: PoolRef = { token: TOKEN, pair: PAIR, tokenIsZero: true };
    const scan = await scanTrades(t, PAD, TOKEN, 1n, 10n, [pool]);
    assert.equal(scan.truncated, false);
    const brief = scan.trades.map((x) => [x.type, x.kind ?? "", x.trader.toLowerCase()]);
    assert.deepEqual(brief, [
      ["buy", "", WALLET.toLowerCase()],
      ["sell", "harvest", MIGRATOR.toLowerCase()],
      ["buy", "buyback", PAD.toLowerCase()],
      ["buy", "", MIGRATOR.toLowerCase()],
      ["sell", "", WALLET.toLowerCase()],
    ]);
    // a harvest is still a sell on the DEX: its amounts are the swap's
    const harvest = scan.trades[1];
    assert.equal(harvest.venue, "pool");
    assert.equal(harvest.tokens, 50n * COIN);
    assert.equal(harvest.eth, QUOTE / 20n);
    // the pad asked once for the migrator, and not again on the next scan
    assert.equal(calls.call, 1);
    await scanTrades(t, PAD, TOKEN, 11n, 20n, [pool]);
    assert.equal(calls.call, 1);
  });
});

test("a ref that names the migrator spares the pad the question", async () => {
  await withNode(async (t, calls) => {
    const scan = await scanTrades(t, PAD, null, 1n, 10n, [{ token: TOKEN, pair: PAIR, tokenIsZero: true, migrator: MIGRATOR }]);
    assert.equal(calls.call, 0);
    assert.deepEqual(
      scan.trades.map((x) => x.kind ?? ""),
      ["", "harvest", "buyback", "", ""]
    );
  });
});

test("the coin on the pair's other side reads the same", async () => {
  await withNode(async (t) => {
    // the same logs, the coin now token1: amount0 is the quote, amount1 the coin
    const scan = await scanTrades(t, PAD, TOKEN, 1n, 10n, [{ token: TOKEN, pair: PAIR, tokenIsZero: false, migrator: MIGRATOR }]);
    // every swap now reads with the sides crossed: the harvest (coins in, quote out) becomes quote in, coins out
    assert.deepEqual(
      scan.trades.map((x) => [x.type, x.kind ?? ""]),
      [
        ["sell", ""],
        ["buy", ""], // the migrator "buying" for itself: a nudge's shape
        ["sell", ""], // coins in, quote out to the pad: not a harvest (the quote did not go to the migrator)
        ["sell", "harvest"],
        ["buy", ""],
      ]
    );
  });
});

test("the packed form carries the kind, and reads the form before it", () => {
  const trade: Trade = {
    type: "sell",
    token: TOKEN,
    trader: MIGRATOR,
    eth: 5n,
    tokens: 7n,
    block: 9n,
    tx: "0x01",
    timestamp: 1,
    venue: "pool",
    kind: "harvest",
  };
  const plain: Trade = { ...trade, type: "buy", trader: WALLET, kind: undefined };
  delete plain.kind;
  const packed = packTrades([trade, plain]);
  assert.equal(packed[0][9], "harvest");
  assert.equal(packed[1][9], "");
  const back = unpackTrades(packed);
  assert.deepEqual(back[0], trade);
  assert.deepEqual(back[1], plain);
  assert.equal("kind" in back[1], false);
  // nine elements, as the edge may still hold them: no kind
  const old = packed[0].slice(0, 9) as PackedTrade;
  assert.equal("kind" in unpackTrades([old])[0], false);
});
