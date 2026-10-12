// The migration tree of a snapshot file, as LaunchpadMigration checks it and
// script/MerkleTree.sol rebuilds it: one leaf per coin as the ledger recorded
// it (everything migrateToken is given about it), one per holder's balance of
// it, in the file's order; OpenZeppelin's standard leaves (the abi-encoded
// values hashed twice, so no inner node can pose as a leaf), pairs hashed
// sorted, an odd node carried up unchanged. The file's `stateRoot` is this
// tree's root: the pad commits to it (setMigrationRoot) and from then on
// delivers only what proves itself a leaf of it. Anyone can run
// snapshot-evm.mjs on the frozen source and compare the root.
//
//   import { migrationTree } from "./merkle.mjs";
//   const { root, leaves, proof } = migrationTree(coins, destQuote);   // proof(i): the i-th leaf's
//
// Needs web/'s node_modules (viem), like snapshot-evm.mjs.
import {
  concat,
  encodeAbiParameters,
  getAddress,
  keccak256,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "../../web/node_modules/viem/_esm/index.js";

const strings = (names) => names.map((name) => ({ name, type: "string" }));
const uint16s = (names) => names.map((name) => ({ name, type: "uint16" }));
/** LaunchpadBase.LedgerCoin, field for field. */
export const LEDGER_COIN = {
  type: "tuple",
  components: [
    { name: "name", type: "string" },
    { name: "symbol", type: "string" },
    { name: "meta", type: "tuple", components: strings(["logoURI", "website", "twitter", "telegram", "livestream", "description"]) },
    { name: "creator", type: "address" },
    { name: "feeRecipient", type: "address" },
    {
      name: "fees",
      type: "tuple",
      components: uint16s(["buyTaxBps", "sellTaxBps", "creatorBps", "holdersBps", "burnBps", "liquidityBps", "platformBps"]),
    },
    { name: "quoteAsset", type: "address" },
    { name: "quoteAmount", type: "uint256" },
    { name: "virtualQuote", type: "uint256" },
    { name: "sold", type: "uint256" },
    { name: "burned", type: "uint256" },
    { name: "poolToken", type: "uint256" },
    { name: "burnPot", type: "uint256" },
    { name: "liquidityPot", type: "uint256" },
  ],
};
const LEAF_COIN = 1;
const LEAF_HOLDER = 2;

/** A coin of the file as MigrateFromLedger.s.sol hands it to migrateToken: funded in the
 *  destination's quote with its reserve and its pots, the launchpad's own rate left for the
 *  pad to stamp (platformBps 0). */
export function ledgerCoin(c, destQuote = zeroAddress) {
  return {
    name: c.name,
    symbol: c.symbol,
    meta: {
      logoURI: c.logo ?? "",
      website: c.website ?? "",
      twitter: c.twitter ?? "",
      telegram: c.telegram ?? "",
      livestream: c.livestream ?? "",
      description: c.description ?? "",
    },
    creator: getAddress(c.creator),
    feeRecipient: getAddress(c.feeRecipient ?? zeroAddress),
    fees: {
      buyTaxBps: Number(c.buyTaxBps),
      sellTaxBps: Number(c.sellTaxBps),
      creatorBps: Number(c.creatorBps),
      holdersBps: Number(c.holdersBps),
      burnBps: Number(c.burnBps),
      liquidityBps: Number(c.liquidityBps),
      platformBps: 0,
    },
    quoteAsset: getAddress(destQuote),
    quoteAmount: BigInt(c.realQuote) + BigInt(c.burnPot) + BigInt(c.liquidityPot),
    virtualQuote: BigInt(c.virtualQuote),
    sold: BigInt(c.sold),
    burned: BigInt(c.burned),
    poolToken: BigInt(c.poolToken),
    burnPot: BigInt(c.burnPot),
    liquidityPot: BigInt(c.liquidityPot),
  };
}

const standardLeaf = (encoded) => keccak256(keccak256(encoded));
/** The leaf of a coin: LaunchpadMigration.migrationLeafCoin. */
export const coinLeaf = (coin) => standardLeaf(encodeAbiParameters([{ type: "uint8" }, LEDGER_COIN], [LEAF_COIN, coin]));
/** The leaf of one holder's balance: LaunchpadMigration.migrationLeafHolder. */
export const holderLeaf = (symbol, holder, amount) =>
  standardLeaf(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [LEAF_HOLDER, keccak256(stringToHex(symbol)), getAddress(holder), BigInt(amount)]
    )
  );

/** OpenZeppelin's commutative pair hash: the two sorted, concatenated, hashed. */
const hashPair = (a, b) => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** The tree over `leaves` as given: its root, and proof(i) for the i-th leaf. */
export function buildTree(leaves) {
  const levels = [leaves.slice()];
  while (levels[levels.length - 1].length > 1) {
    const level = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    levels.push(next);
  }
  const root = leaves.length === 0 ? zeroHash : levels[levels.length - 1][0];
  const proof = (index) => {
    if (!(index >= 0 && index < leaves.length)) throw new Error(`no leaf ${index}`);
    const siblings = [];
    let i = index;
    for (let d = 0; d < levels.length - 1; d++) {
      const sibling = i ^ 1;
      if (sibling < levels[d].length) siblings.push(levels[d][sibling]);
      i = Math.floor(i / 2);
    }
    return siblings;
  };
  return { root, proof };
}

/** The tree of a snapshot file's coins: coin by coin, its leaf then its holders'. */
export function migrationTree(coins, destQuote = zeroAddress) {
  const leaves = [];
  for (const c of coins) {
    if (c.holders.length !== c.balances.length) throw new Error(`${c.symbol}: holders and balances differ in length`);
    leaves.push(coinLeaf(ledgerCoin(c, destQuote)));
    for (let j = 0; j < c.holders.length; j++) leaves.push(holderLeaf(c.symbol, c.holders[j], c.balances[j]));
  }
  return { leaves, ...buildTree(leaves) };
}

/** A snapshot file's text with its big integers kept whole (JSON.parse would round them). */
export function parseSnapshot(text) {
  return JSON.parse(text.replace(/([:\[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}
