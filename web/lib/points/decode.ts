// The pad's logs that the points read, and nothing else: a coin and its
// creator, a trade, a graduation, a freeze announced or withdrawn. The same
// signatures on every pad the site reads (v7.7 on Liteforge, v12 on Base; a
// pad without the withdrawal event simply never emits it).

import { decodeEventLog, encodeEventTopics, parseAbi } from "viem";

export const padEventsAbi = parseAbi([
  "event TokenCreated(address indexed token, address indexed creator, string name, string symbol, bool feesToHolders)",
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee)",
  "event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee)",
  "event Graduated(address indexed token, uint256 raisedEth)",
  "event FreezeAnnounced(uint256 freezeBlock)",
  "event FreezeCancelled()",
]);

const topic = (eventName: "TokenCreated" | "Bought" | "Sold" | "Graduated" | "FreezeAnnounced" | "FreezeCancelled") =>
  encodeEventTopics({ abi: padEventsAbi, eventName })[0];

export const TOPICS = {
  created: topic("TokenCreated"),
  bought: topic("Bought"),
  sold: topic("Sold"),
  graduated: topic("Graduated"),
  freeze: topic("FreezeAnnounced"),
  freezeCancelled: topic("FreezeCancelled"),
} as const;

/** the topic0 filter for one eth_getLogs over the pad */
export const PAD_TOPICS: `0x${string}`[] = [TOPICS.created, TOPICS.bought, TOPICS.sold, TOPICS.graduated, TOPICS.freeze, TOPICS.freezeCancelled];

/** a coin's ERC-20 Transfer: who holds a coin is read from these, every coin of the pad at once */
export const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
export const TRANSFER_TOPIC = encodeEventTopics({ abi: transferAbi, eventName: "Transfer" })[0];

/** an eth_getLogs entry as the node returns it */
export type RpcLog = {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: `0x${string}`;
  removed?: boolean;
};

export type PadEvent =
  | { kind: "created"; block: bigint; logIndex: number; tx: `0x${string}`; token: `0x${string}`; creator: `0x${string}` }
  | {
      kind: "bought" | "sold";
      block: bigint;
      logIndex: number;
      tx: `0x${string}`;
      token: `0x${string}`;
      wallet: `0x${string}`;
      quote: bigint;
      tokens: bigint;
    }
  | { kind: "graduated"; block: bigint; logIndex: number; tx: `0x${string}`; token: `0x${string}`; raised: bigint }
  | { kind: "freeze"; block: bigint; logIndex: number; tx: `0x${string}`; freezeBlock: bigint }
  | { kind: "freezeCancelled"; block: bigint; logIndex: number; tx: `0x${string}` }
  /** a coin's Transfer (the coin is the log's address): the mint to the pad at birth, a buy, a
   *  sell, a migration's delivery, a pool's swap, a burn; balances are the sum of these */
  | { kind: "transfer"; block: bigint; logIndex: number; tx: `0x${string}`; token: `0x${string}`; from: `0x${string}`; to: `0x${string}`; value: bigint };

const low = (a: string) => a.toLowerCase() as `0x${string}`;

/** one log into one event; null for a log of another kind (or a removed one) */
export function decodePadLog(log: RpcLog): PadEvent | null {
  if (log.removed) return null;
  const t0 = log.topics[0];
  if (!t0) return null;
  const base = { block: BigInt(log.blockNumber), logIndex: Number(BigInt(log.logIndex)), tx: log.transactionHash };
  const topics = log.topics as [`0x${string}`, ...`0x${string}`[]];
  try {
    if (t0 === TOPICS.created) {
      const d = decodeEventLog({ abi: padEventsAbi, eventName: "TokenCreated", data: log.data, topics });
      return { kind: "created", ...base, token: low(d.args.token), creator: low(d.args.creator) };
    }
    if (t0 === TOPICS.bought) {
      const d = decodeEventLog({ abi: padEventsAbi, eventName: "Bought", data: log.data, topics });
      return { kind: "bought", ...base, token: low(d.args.token), wallet: low(d.args.buyer), quote: d.args.ethIn, tokens: d.args.tokensOut };
    }
    if (t0 === TOPICS.sold) {
      const d = decodeEventLog({ abi: padEventsAbi, eventName: "Sold", data: log.data, topics });
      return { kind: "sold", ...base, token: low(d.args.token), wallet: low(d.args.seller), quote: d.args.ethOut, tokens: d.args.tokensIn };
    }
    if (t0 === TOPICS.graduated) {
      const d = decodeEventLog({ abi: padEventsAbi, eventName: "Graduated", data: log.data, topics });
      return { kind: "graduated", ...base, token: low(d.args.token), raised: d.args.raisedEth };
    }
    if (t0 === TOPICS.freeze) {
      const d = decodeEventLog({ abi: padEventsAbi, eventName: "FreezeAnnounced", data: log.data, topics });
      return { kind: "freeze", ...base, freezeBlock: d.args.freezeBlock };
    }
    if (t0 === TOPICS.freezeCancelled) {
      decodeEventLog({ abi: padEventsAbi, eventName: "FreezeCancelled", data: log.data, topics }); // the shape check
      return { kind: "freezeCancelled", ...base };
    }
  } catch {
    return null; // a log with this topic but another shape: not ours
  }
  return null;
}

/** one Transfer log of a coin into one event; null for anything else (a log of another shape, a removed one) */
export function decodeTransferLog(log: RpcLog): PadEvent | null {
  if (log.removed || log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) return null;
  const topics = log.topics as [`0x${string}`, ...`0x${string}`[]];
  try {
    const d = decodeEventLog({ abi: transferAbi, eventName: "Transfer", data: log.data, topics });
    return {
      kind: "transfer",
      block: BigInt(log.blockNumber),
      logIndex: Number(BigInt(log.logIndex)),
      tx: log.transactionHash,
      token: low(log.address),
      from: low(d.args.from),
      to: low(d.args.to),
      value: d.args.value,
    };
  } catch {
    return null;
  }
}

export const eventOrder = (a: { block: bigint; logIndex: number }, b: { block: bigint; logIndex: number }) =>
  a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1;
