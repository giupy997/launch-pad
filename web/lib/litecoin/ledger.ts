// Notus on Litecoin — the ledger.
//
// Litecoin has no smart contracts, so the launchpad is a set of rules
// replayed over the transactions that pay one ordinary address (the desk)
// and carry an instruction in their OP_RETURN output. This file IS those
// rules: a pure, deterministic function from an ordered list of
// transactions to balances. Anyone with a Litecoin node, or a block
// explorer, can run it over the same blocks and must land on the same
// state root.
//
// It mirrors Launchpad.sol and the Zcash ledger: constant-product bonding
// curve with virtual reserves, 1% fee split 20% treasury / 80% to the
// creator or to the holders (the coin's launch-time choice, pro-rata
// accumulator with debts rounded up). What the chain changes: Litecoin is
// transparent and every transaction is signed by whoever funds it, so a
// balance belongs to a Litecoin ADDRESS — the one that pays for the
// transaction (its first input) — and no extra key, signature or nonce is
// needed: the chain already authenticated the sender, and a transaction can
// only be mined once. Where an instruction names another address (a
// recipient, a payout address) it points at one of its own outputs, because
// an OP_RETURN holds 80 bytes and a bech32 address alone can take 62.
// There is no DEX to graduate to: the curve stays the market, sells always
// have liquidity, and the last 200M stay reserved.

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

export const PROTOCOL = "NOTUS1";

export type Network = "test" | "main";

/** Litecoin Core relays at most 80 bytes of OP_RETURN data (MAX_OP_RETURN_RELAY = 83). */
export const MEMO_MAX_BYTES = 80;

export const TOKEN_UNIT = 100_000_000n; // 8 decimals, like LTC
export const TOTAL_SUPPLY = 1_000_000_000n * TOKEN_UNIT;
export const CURVE_SUPPLY = 800_000_000n * TOKEN_UNIT;
export const VIRTUAL_TOKEN = 1_050_000_000n * TOKEN_UNIT;

export const FEE_BPS = 100n; // 1% on buys and sells
export const POT_BPS = 8_000n; // of the fee: creator or holders; the rest is treasury
const BPS = 10_000n;
const ACC_PRECISION = 10n ** 30n;
const MIN_ELIGIBLE = TOKEN_UNIT; // no holder distribution over less than one coin

export type Params = {
  network: Network;
  /** Virtual LTC reserve at curve start: sets the opening price and the raise
   *  (~3.2x this). Small on testnet, where faucet LTC is scarce. */
  virtualLit: bigint;
  deployFeeLit: bigint;
  /** Smallest payout the desk will send — below this a network fee eats it. */
  minPayoutLit: bigint;
  /** Migration freeze: past this block height the ledger takes no new deploy,
   *  buy, sell, send or logo (the LTC they carry is credited back); claims
   *  and the desk's payouts keep working so everyone can be paid out. null =
   *  not frozen. The frozen state is what gets re-created on LitVM. */
  freezeHeight: number | null;
};

export const PARAMS: Record<Network, Params> = {
  test: { network: "test", virtualLit: 20_000_000n, deployFeeLit: 100_000n, minPayoutLit: 50_000n, freezeHeight: null },
  main: { network: "main", virtualLit: 2_000_000_000n, deployFeeLit: 1_000_000n, minPayoutLit: 50_000n, freezeHeight: null },
};

/** One output of a transaction, as the ledger needs to see it. */
export type TxOutput = {
  /** Decoded address, or null for OP_RETURN and non-standard scripts. */
  address: string | null;
  lit: bigint;
  /** true when this output pays the desk. */
  toDesk: boolean;
};

/** One transaction that involves the desk, as read off the chain. */
export type TxEvent = {
  height: number;
  /** Position of the transaction in its block. */
  txIndex: number;
  txid: string;
  time: number; // block time, unix seconds
  /** Address that funded the first input: the actor of the instruction.
   *  null when it is not a standard single-address script (or a coinbase). */
  sender: string | null;
  /** The sender's compressed secp256k1 public key, revealed by its signature
   *  (witness or scriptSig). Litecoin and EVM chains share the curve, so it
   *  also names the sender's address on LitVM for the migration. */
  senderPubkey?: string | null;
  outputs: TxOutput[];
  /** LTC paid to the desk by this transaction (0 for the desk's own). */
  valueLit: bigint;
  /** The OP_RETURN payload as text, or null when there is none. */
  memo: string | null;
  /** true = spends the desk's coins (payout confirmations), false = received. */
  fromDesk: boolean;
};

export type Coin = {
  ticker: string;
  name: string;
  logo: string;
  creator: string; // Litecoin address
  feesToHolders: boolean;
  vLit: bigint;
  vToken: bigint;
  realLit: bigint;
  sold: bigint;
  acc: bigint; // cashback per token unit, scaled by ACC_PRECISION
  volumeLit: bigint;
  trades: number;
  createdHeight: number;
  createdTime: number;
  txid: string;
};

export type Trade = {
  ticker: string;
  type: "buy" | "sell";
  holder: string;
  lit: bigint; // gross LTC in (buy) or net LTC out (sell)
  tokens: bigint;
  fee: bigint;
  height: number;
  time: number;
  txid: string;
};

export type Payout = {
  id: number;
  kind: "sell" | "claim";
  holder: string;
  to: string;
  lit: bigint;
  height: number;
  txid: string;
  paidTxid: string | null;
};

export type Rejection = { txid: string; height: number; reason: string; memo: string };

export type State = {
  network: Network;
  height: number;
  coins: Map<string, Coin>;
  balances: Map<string, Map<string, bigint>>; // ticker -> address -> tokens
  debts: Map<string, Map<string, bigint>>;
  pending: Map<string, Map<string, bigint>>; // settled, unclaimed cashback
  /** Claimable LTC per address: creator fees, refunds, surplus, carried dust. */
  credit: Map<string, bigint>;
  /** Public key of every address that ever signed a transaction to the desk
   *  (not part of the state root: it is chain data, not ownership). */
  pubkeys: Map<string, string>;
  freezeHeight: number | null;
  treasuryLit: bigint;
  payouts: Payout[];
  trades: Trade[];
  rejected: Rejection[];
  txsRead: number;
  roots: { height: number; root: string }[];
};

export function emptyState(network: Network): State {
  return {
    network,
    height: 0,
    coins: new Map(),
    balances: new Map(),
    debts: new Map(),
    pending: new Map(),
    credit: new Map(),
    pubkeys: new Map(),
    freezeHeight: null,
    treasuryLit: 0n,
    payouts: [],
    trades: [],
    rejected: [],
    txsRead: 0,
    roots: [],
  };
}

// ------------------------------------------------------------------ curve

export function quoteBuy(c: Pick<Coin, "vLit" | "vToken" | "sold">, litIn: bigint) {
  const fee = (litIn * FEE_BPS) / BPS;
  let forCurve = litIn - fee;
  const k = c.vLit * c.vToken;
  let tokensOut = forCurve > 0n ? c.vToken - k / (c.vLit + forCurve) : 0n;
  let refund = 0n;
  let feeOut = fee;
  const remaining = CURVE_SUPPLY - c.sold;
  if (tokensOut >= remaining) {
    // the curve is selling out: charge only what the last coins cost
    tokensOut = remaining;
    const needed = remaining > 0n ? k / (c.vToken - remaining) - c.vLit + 1n : 0n;
    if (needed < forCurve) forCurve = needed;
    feeOut = (forCurve * FEE_BPS) / (BPS - FEE_BPS);
    const total = forCurve + feeOut;
    refund = litIn > total ? litIn - total : 0n;
    if (total > litIn) feeOut = litIn - forCurve; // litoshi-level gross-up rounding
  }
  return { tokensOut, forCurve, fee: feeOut, refund };
}

export function quoteSell(c: Pick<Coin, "vLit" | "vToken" | "realLit">, tokensIn: bigint) {
  const k = c.vLit * c.vToken;
  let gross = c.vLit - k / (c.vToken + tokensIn);
  if (gross > c.realLit) gross = c.realLit;
  const fee = (gross * FEE_BPS) / BPS;
  return { gross, fee, net: gross - fee };
}

/** Spot price in LTC per whole coin. Display only — a coin costs a fraction
 *  of a litoshi early on, so this is a float; the ledger never uses it. */
export function spotPrice(c: { vLit: bigint | string; vToken: bigint | string }): number {
  return Number(c.vLit) / Number(c.vToken);
}

// ------------------------------------------------------------------ memos

const enc = (s: string) => encodeURIComponent(s);

/** UTF-8 length of a memo: it must fit in 80 bytes to be relayed. */
export function memoBytes(m: string): number {
  return utf8ToBytes(m).length;
}

/** The instructions. `o` values are output indexes of the same transaction. */
export const memo = {
  deploy: (ticker: string, name: string, feesToHolders: boolean, logo = "") =>
    [PROTOCOL, "deploy", ticker, enc(name), feesToHolders ? "h" : "c", ...(logo ? [logo] : [])].join(" "),
  logo: (ticker: string, url: string) => [PROTOCOL, "logo", ticker, url].join(" "),
  buy: (ticker: string, minOut = 0n) => [PROTOCOL, "buy", ticker, ...(minOut > 0n ? [minOut] : [])].join(" "),
  sell: (ticker: string, amount: bigint, minLit: bigint, payoutOutput?: number) =>
    [PROTOCOL, "sell", ticker, amount, minLit, ...(payoutOutput === undefined ? [] : [payoutOutput])].join(" "),
  send: (ticker: string, amount: bigint, toOutput: number) => [PROTOCOL, "send", ticker, amount, toOutput].join(" "),
  claim: (payoutOutput?: number) => [PROTOCOL, "claim", ...(payoutOutput === undefined ? [] : [payoutOutput])].join(" "),
  paid: (ids: number[]) => [PROTOCOL, "paid", ...ids].join(" "),
};

const TICKER = /^[A-Z0-9]{2,8}$/;
const URL_FIELD = /^(https?:\/\/|ipfs:\/\/)\S{1,300}$/;

function uint(s: string | undefined): bigint | null {
  return s !== undefined && /^[0-9]{1,30}$/.test(s) ? BigInt(s) : null;
}

function index(s: string | undefined): number | null {
  return s !== undefined && /^(0|[1-9][0-9]{0,3})$/.test(s) ? Number(s) : null;
}

function text(s: string | undefined, max: number): string | null {
  if (s === undefined) return "";
  try {
    const v = decodeURIComponent(s);
    return v.length <= max ? v : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- engine

function get(m: Map<string, Map<string, bigint>>, ticker: string, holder: string): bigint {
  return m.get(ticker)?.get(holder) ?? 0n;
}

function set(m: Map<string, Map<string, bigint>>, ticker: string, holder: string, v: bigint) {
  let inner = m.get(ticker);
  if (!inner) m.set(ticker, (inner = new Map()));
  if (v === 0n) inner.delete(holder);
  else inner.set(holder, v);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Harvest a holder's cashback at their old balance, re-anchor at the new
 *  one (debt rounds up: the sum of all claims never exceeds the pot). */
function settle(s: State, coin: Coin, holder: string, oldBal: bigint, newBal: bigint) {
  const earned = (oldBal * coin.acc) / ACC_PRECISION;
  const debt = get(s.debts, coin.ticker, holder);
  if (earned > debt) set(s.pending, coin.ticker, holder, get(s.pending, coin.ticker, holder) + earned - debt);
  set(s.debts, coin.ticker, holder, ceilDiv(newBal * coin.acc, ACC_PRECISION));
}

function move(s: State, coin: Coin, holder: string, delta: bigint) {
  const old = get(s.balances, coin.ticker, holder);
  settle(s, coin, holder, old, old + delta);
  set(s.balances, coin.ticker, holder, old + delta);
}

function addCredit(s: State, holder: string, lit: bigint) {
  if (lit > 0n) s.credit.set(holder, (s.credit.get(holder) ?? 0n) + lit);
}

function splitFee(s: State, coin: Coin, fee: bigint) {
  const pot = (fee * POT_BPS) / BPS;
  let toTreasury = fee - pot;
  if (pot > 0n) {
    if (!coin.feesToHolders) addCredit(s, coin.creator, pot);
    else if (coin.sold >= MIN_ELIGIBLE) coin.acc += (pot * ACC_PRECISION) / coin.sold;
    else toTreasury = fee;
  }
  s.treasuryLit += toTreasury;
}

/** The address an instruction points at: one of its own transaction's
 *  outputs, which must pay a real address other than the desk. */
function pointedAddress(e: TxEvent, raw: string | undefined): string | null {
  const i = index(raw);
  if (i === null) return null;
  const o = e.outputs[i];
  return o && o.address && !o.toDesk ? o.address : null;
}

function buy(s: State, e: TxEvent, coin: Coin, holder: string, litIn: bigint, minOut: bigint): string | null {
  const q = quoteBuy(coin, litIn);
  if (q.tokensOut === 0n || q.tokensOut < minOut) {
    addCredit(s, holder, litIn); // nothing bought: the LTC stays the buyer's
    return q.tokensOut === 0n ? "sold out or amount too small — credited" : "slippage — credited";
  }
  coin.vLit += q.forCurve;
  coin.vToken -= q.tokensOut;
  coin.realLit += q.forCurve;
  coin.sold += q.tokensOut;
  coin.volumeLit += litIn - q.refund;
  coin.trades++;
  move(s, coin, holder, q.tokensOut);
  splitFee(s, coin, q.fee);
  addCredit(s, holder, q.refund);
  s.trades.push({
    ticker: coin.ticker, type: "buy", holder, lit: litIn - q.refund, tokens: q.tokensOut, fee: q.fee,
    height: e.height, time: e.time, txid: e.txid,
  });
  return null;
}

/** Settle the payouts a desk transaction says it paid: each id needs its
 *  own output to the payee, worth at least what is owed. */
function paid(s: State, e: TxEvent, ids: string[]): string | null {
  const used = new Set<number>();
  const failed: string[] = [];
  let settled = 0;
  for (const raw of ids) {
    const id = uint(raw);
    const po = id === null ? undefined : s.payouts[Number(id)];
    if (!po || po.paidTxid) {
      failed.push(`#${raw}: unknown or already paid`);
      continue;
    }
    const i = e.outputs.findIndex((o, j) => !used.has(j) && o.address === po.to && o.lit >= po.lit);
    if (i < 0) {
      failed.push(`#${raw}: no output pays it in full`);
      continue;
    }
    used.add(i);
    po.paidTxid = e.txid;
    settled++;
  }
  if (failed.length && settled) s.rejected.push({ txid: e.txid, height: e.height, reason: failed.join("; "), memo: e.memo?.slice(0, 120) ?? "" });
  return settled ? null : failed.join("; ") || "nothing to settle";
}

/** Apply one transaction. Returns a rejection reason, or null when it was folded in. */
function apply(s: State, p: Params, e: TxEvent): string | null {
  const m = e.memo ?? "";
  const f = m.trim().split(/\s+/);
  const isNotus = f[0] === PROTOCOL && memoBytes(m) <= MEMO_MAX_BYTES;
  const cmd = isNotus ? f[1] : undefined;

  if (e.fromDesk) {
    if (cmd !== "paid") return "desk transaction without a payout memo";
    return paid(s, e, f.slice(2));
  }

  // A payment to the desk always has an owner: the address that funded it.
  // Whatever the memo says (or fails to say), that LTC is never lost.
  const sender = e.sender;
  if (!sender) {
    s.treasuryLit += e.valueLit; // nobody to credit — a non-standard first input
    return "no recognisable sender";
  }
  if (e.senderPubkey) s.pubkeys.set(sender, e.senderPubkey);
  if (!isNotus) {
    addCredit(s, sender, e.valueLit);
    return e.memo === null ? "no memo — credited" : memoBytes(m) > MEMO_MAX_BYTES ? "memo over 80 bytes — credited" : "not a Notus memo — credited";
  }
  if (cmd === "paid") {
    addCredit(s, sender, e.valueLit);
    return "only the desk confirms payouts — credited";
  }
  if (p.freezeHeight !== null && e.height > p.freezeHeight && cmd !== "claim") {
    return credited(s, sender, e, "ledger frozen for migration");
  }

  if (cmd === "deploy") {
    const [, , ticker, nameRaw, mode, logo] = f;
    const name = text(nameRaw, 32);
    if (!ticker || !TICKER.test(ticker)) return credited(s, sender, e, "bad ticker");
    if (!name || (logo !== undefined && !URL_FIELD.test(logo))) return credited(s, sender, e, "bad name or logo");
    if (mode !== "c" && mode !== "h") return credited(s, sender, e, "bad fee mode");
    if (e.valueLit < p.deployFeeLit) return credited(s, sender, e, "deploy fee not covered");
    if (s.coins.has(ticker)) return credited(s, sender, e, "ticker taken");
    const coin: Coin = {
      ticker, name, logo: logo ?? "", creator: sender, feesToHolders: mode === "h",
      vLit: p.virtualLit, vToken: VIRTUAL_TOKEN, realLit: 0n, sold: 0n, acc: 0n,
      volumeLit: 0n, trades: 0, createdHeight: e.height, createdTime: e.time, txid: e.txid,
    };
    s.coins.set(ticker, coin);
    s.treasuryLit += p.deployFeeLit;
    const devBuy = e.valueLit - p.deployFeeLit;
    return devBuy > 0n ? buy(s, e, coin, sender, devBuy, 0n) : null;
  }

  if (cmd === "logo") {
    const [, , ticker, url] = f;
    const coin = s.coins.get(ticker ?? "");
    addCredit(s, sender, e.valueLit); // the dust that carried the memo
    if (!coin) return "unknown coin";
    if (coin.creator !== sender) return "only the creator sets the logo";
    if (!url || !URL_FIELD.test(url)) return "bad logo";
    coin.logo = url;
    return null;
  }

  if (cmd === "buy") {
    const [, , ticker, minRaw] = f;
    const coin = s.coins.get(ticker ?? "");
    const minOut = minRaw === undefined ? 0n : uint(minRaw);
    if (!coin || minOut === null) return credited(s, sender, e, "unknown coin or bad minimum");
    if (e.valueLit === 0n) return "no LTC attached";
    return buy(s, e, coin, sender, e.valueLit, minOut);
  }

  if (cmd === "sell") {
    const [, , ticker, amountRaw, minRaw, outRaw] = f;
    const coin = s.coins.get(ticker ?? "");
    const amount = uint(amountRaw), minLit = uint(minRaw);
    addCredit(s, sender, e.valueLit); // the dust that carried the memo
    if (!coin || amount === null || minLit === null || amount === 0n) return "bad sell";
    const payout = outRaw === undefined ? sender : pointedAddress(e, outRaw);
    if (!payout) return "bad payout output";
    if (get(s.balances, coin.ticker, sender) < amount) return "insufficient balance";
    const q = quoteSell(coin, amount);
    if (q.net < minLit) return "slippage";
    if (q.net < p.minPayoutLit) return "below the minimum payout";
    coin.vLit -= q.gross;
    coin.vToken += amount;
    coin.realLit -= q.gross;
    coin.sold -= amount;
    coin.volumeLit += q.gross;
    coin.trades++;
    move(s, coin, sender, -amount);
    splitFee(s, coin, q.fee);
    s.payouts.push({ id: s.payouts.length, kind: "sell", holder: sender, to: payout, lit: q.net, height: e.height, txid: e.txid, paidTxid: null });
    s.trades.push({ ticker: coin.ticker, type: "sell", holder: sender, lit: q.net, tokens: amount, fee: q.fee, height: e.height, time: e.time, txid: e.txid });
    return null;
  }

  if (cmd === "send") {
    const [, , ticker, amountRaw, outRaw] = f;
    const coin = s.coins.get(ticker ?? "");
    const amount = uint(amountRaw);
    addCredit(s, sender, e.valueLit);
    if (!coin || amount === null || amount === 0n) return "bad send";
    const to = pointedAddress(e, outRaw);
    if (!to) return "bad recipient output";
    if (get(s.balances, coin.ticker, sender) < amount) return "insufficient balance";
    if (to !== sender) {
      move(s, coin, sender, -amount);
      move(s, coin, to, amount);
    }
    return null;
  }

  if (cmd === "claim") {
    const [, , outRaw] = f;
    addCredit(s, sender, e.valueLit);
    const payout = outRaw === undefined ? sender : pointedAddress(e, outRaw);
    if (!payout) return "bad payout output";
    let total = s.credit.get(sender) ?? 0n;
    for (const coin of s.coins.values()) {
      const bal = get(s.balances, coin.ticker, sender);
      settle(s, coin, sender, bal, bal);
      total += get(s.pending, coin.ticker, sender);
    }
    if (total < p.minPayoutLit) return "below the minimum payout"; // nothing is lost: it keeps accruing
    for (const coin of s.coins.values()) set(s.pending, coin.ticker, sender, 0n);
    s.credit.delete(sender);
    s.payouts.push({ id: s.payouts.length, kind: "claim", holder: sender, to: payout, lit: total, height: e.height, txid: e.txid, paidTxid: null });
    return null;
  }

  addCredit(s, sender, e.valueLit);
  return "unknown command — credited";
}

/** Reject an instruction but keep the LTC it carried refundable. */
function credited(s: State, sender: string, e: TxEvent, reason: string): string {
  addCredit(s, sender, e.valueLit);
  return `${reason} — credited`;
}

/** Everything an address could claim right now, in litoshi. */
export function claimableLit(s: State, holder: string): bigint {
  let total = s.credit.get(holder) ?? 0n;
  for (const coin of s.coins.values()) {
    const entitled = (get(s.balances, coin.ticker, holder) * coin.acc) / ACC_PRECISION;
    const debt = get(s.debts, coin.ticker, holder);
    total += get(s.pending, coin.ticker, holder) + (entitled > debt ? entitled - debt : 0n);
  }
  return total;
}

/** LTC the desk must hold to honour every coin, claim and unpaid payout. */
export function liabilitiesLit(s: State): bigint {
  let total = 0n;
  for (const c of s.coins.values()) total += c.realLit;
  const holders = new Set<string>(s.credit.keys());
  for (const m of s.balances.values()) for (const h of m.keys()) holders.add(h);
  for (const m of s.pending.values()) for (const h of m.keys()) holders.add(h);
  for (const h of holders) total += claimableLit(s, h);
  for (const po of s.payouts) if (!po.paidTxid) total += po.lit;
  return total;
}

export function replay(network: Network, events: TxEvent[], params: Params = PARAMS[network]): State {
  const s = emptyState(network);
  s.freezeHeight = params.freezeHeight;
  const seen = new Set<string>();
  const ordered = [...events]
    .filter((e) => (seen.has(e.txid) ? false : (seen.add(e.txid), true)))
    .sort((a, b) => a.height - b.height || a.txIndex - b.txIndex || (a.txid < b.txid ? -1 : 1));
  let i = 0;
  while (i < ordered.length) {
    const height = ordered[i].height;
    for (; i < ordered.length && ordered[i].height === height; i++) {
      const e = ordered[i];
      s.txsRead++;
      const reason = apply(s, params, e);
      if (reason) s.rejected.push({ txid: e.txid, height: e.height, reason, memo: (e.memo ?? "").slice(0, 120) });
    }
    s.height = height;
    s.roots.push({ height, root: stateRoot(s) });
  }
  return s;
}

// ---------------------------------------------------------- serialisation

function sortedEntries<V>(m: Map<string, V>): [string, V][] {
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function nested(m: Map<string, Map<string, bigint>>) {
  return Object.fromEntries(sortedEntries(m).map(([t, inner]) => [t, Object.fromEntries(sortedEntries(inner).map(([h, v]) => [h, v.toString()]))]));
}

const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

/** Canonical JSON of everything that defines ownership (not the history). */
function canonical(s: State): string {
  return JSON.stringify(
    {
      network: s.network,
      coins: sortedEntries(s.coins).map(([, c]) => c),
      balances: nested(s.balances),
      debts: nested(s.debts),
      pending: nested(s.pending),
      credit: Object.fromEntries(sortedEntries(s.credit)),
      treasuryLit: s.treasuryLit,
      payouts: s.payouts,
    },
    big
  );
}

export function stateRoot(s: State): string {
  return bytesToHex(sha256(utf8ToBytes(canonical(s))));
}

/** JSON snapshot the website reads (bigints as decimal strings). */
export function snapshot(s: State) {
  return JSON.parse(
    JSON.stringify(
      {
        protocol: PROTOCOL,
        network: s.network,
        height: s.height,
        stateRoot: s.roots.at(-1)?.root ?? null,
        freezeHeight: s.freezeHeight,
        txsRead: s.txsRead,
        treasuryLit: s.treasuryLit,
        liabilitiesLit: liabilitiesLit(s),
        coins: sortedEntries(s.coins).map(([, c]) => ({ ...c, holders: s.balances.get(c.ticker)?.size ?? 0 })),
        balances: nested(s.balances),
        claimable: Object.fromEntries(
          [...new Set([...s.credit.keys(), ...[...s.balances.values()].flatMap((m) => [...m.keys()])])]
            .sort()
            .map((h) => [h, claimableLit(s, h).toString()])
            .filter(([, v]) => v !== "0")
        ),
        pubkeys: Object.fromEntries(sortedEntries(s.pubkeys)),
        payouts: s.payouts,
        trades: s.trades.slice(-500),
        rejected: s.rejected.slice(-100),
        roots: s.roots.slice(-50),
      },
      big
    )
  );
}

export type Snapshot = ReturnType<typeof snapshot>;
