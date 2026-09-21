// Notus on Zcash — the ledger.
//
// Zcash has no smart contracts, so the launchpad is a set of rules replayed
// over the encrypted memos sent to one shielded address whose viewing key is
// public. This file IS those rules: a pure, deterministic function from an
// ordered list of memos to balances. Anyone holding the viewing key can run
// it over the same blocks and must land on the same state root.
//
// It mirrors Launchpad.sol: constant-product bonding curve with virtual
// reserves, 1% fee split 20% treasury / 80% to the creator or to the holders
// (the coin's launch-time choice, pro-rata accumulator with debts rounded
// up). Differences forced by the chain: shielded senders are anonymous, so
// balances belong to a HOLDER KEY (ed25519, made in the browser) and every
// spend of a balance is authorised by its signature; ZEC leaving the desk
// (sell proceeds, claims) is a recorded payout the desk wallet then sends.
// There is no DEX to graduate to: the curve stays the market, sells always
// have liquidity, and the last 200M are reserved for the day Zcash Shielded
// Assets ship.

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

export const PROTOCOL = "NOTUS1";

export type Network = "test" | "main";

export const TOKEN_UNIT = 100_000_000n; // 8 decimals, like ZEC
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
  /** Virtual ZEC reserve at curve start: sets the opening price and the raise
   *  (~3.2x this). Small on testnet, where faucet ZEC is scarce. */
  virtualZat: bigint;
  deployFeeZat: bigint;
  /** Smallest payout the desk will send — below this a network fee eats it. */
  minPayoutZat: bigint;
};

export const PARAMS: Record<Network, Params> = {
  test: { network: "test", virtualZat: 30_000_000n, deployFeeZat: 100_000n, minPayoutZat: 50_000n },
  main: { network: "main", virtualZat: 300_000_000n, deployFeeZat: 100_000n, minPayoutZat: 50_000n },
};

/** One memo-carrying output seen by the desk's viewing key. */
export type MemoEvent = {
  height: number;
  txIndex: number;
  outputIndex: number;
  txid: string;
  time: number; // block time, unix seconds
  valueZat: bigint;
  memo: string;
  /** true = sent BY the desk (payout confirmations), false = received. */
  fromDesk: boolean;
};

export type Coin = {
  ticker: string;
  name: string;
  logo: string;
  creator: string; // holder key
  feesToHolders: boolean;
  vZat: bigint;
  vToken: bigint;
  realZat: bigint;
  sold: bigint;
  acc: bigint; // cashback per token unit, scaled by ACC_PRECISION
  volumeZat: bigint;
  trades: number;
  createdHeight: number;
  createdTime: number;
  txid: string;
};

export type Trade = {
  ticker: string;
  type: "buy" | "sell";
  holder: string;
  zat: bigint; // gross ZEC in (buy) or net ZEC out (sell)
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
  zat: bigint;
  height: number;
  txid: string;
  paidTxid: string | null;
};

export type Rejection = { txid: string; height: number; reason: string; memo: string };

export type State = {
  network: Network;
  height: number;
  coins: Map<string, Coin>;
  balances: Map<string, Map<string, bigint>>; // ticker -> holder -> tokens
  debts: Map<string, Map<string, bigint>>;
  pending: Map<string, Map<string, bigint>>; // settled, unclaimed cashback
  /** Claimable ZEC per holder: creator fees, refunds, surplus. */
  credit: Map<string, bigint>;
  nonces: Map<string, bigint>;
  treasuryZat: bigint;
  payouts: Payout[];
  trades: Trade[];
  rejected: Rejection[];
  memosRead: number;
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
    nonces: new Map(),
    treasuryZat: 0n,
    payouts: [],
    trades: [],
    rejected: [],
    memosRead: 0,
    roots: [],
  };
}

// ------------------------------------------------------------------ curve

export function quoteBuy(c: Pick<Coin, "vZat" | "vToken" | "sold">, zatIn: bigint) {
  const fee = (zatIn * FEE_BPS) / BPS;
  let forCurve = zatIn - fee;
  const k = c.vZat * c.vToken;
  let tokensOut = forCurve > 0n ? c.vToken - k / (c.vZat + forCurve) : 0n;
  let refund = 0n;
  let feeOut = fee;
  const remaining = CURVE_SUPPLY - c.sold;
  if (tokensOut >= remaining) {
    // the curve is selling out: charge only what the last coins cost
    tokensOut = remaining;
    const needed = remaining > 0n ? k / (c.vToken - remaining) - c.vZat + 1n : 0n;
    if (needed < forCurve) forCurve = needed;
    feeOut = (forCurve * FEE_BPS) / (BPS - FEE_BPS);
    const total = forCurve + feeOut;
    refund = zatIn > total ? zatIn - total : 0n;
    if (total > zatIn) feeOut = zatIn - forCurve; // wei-level gross-up rounding
  }
  return { tokensOut, forCurve, fee: feeOut, refund };
}

export function quoteSell(c: Pick<Coin, "vZat" | "vToken" | "realZat">, tokensIn: bigint) {
  const k = c.vZat * c.vToken;
  let gross = c.vZat - k / (c.vToken + tokensIn);
  if (gross > c.realZat) gross = c.realZat;
  const fee = (gross * FEE_BPS) / BPS;
  return { gross, fee, net: gross - fee };
}

/** Spot price in ZEC per whole coin. Display only — a coin costs a fraction
 *  of a zatoshi early on, so this is a float; the ledger never uses it. */
export function spotPrice(c: { vZat: bigint | string; vToken: bigint | string }): number {
  return Number(c.vZat) / Number(c.vToken);
}

// ------------------------------------------------------------- signatures

export function signedMessage(network: Network, fields: (string | bigint)[]): Uint8Array {
  return utf8ToBytes([PROTOCOL, network, ...fields.map(String)].join("|"));
}

const b64url = {
  enc(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(s: string): Uint8Array | null {
    try {
      const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  },
};

export function newHolderKey(): { secret: string; holder: string } {
  const sk = ed25519.utils.randomPrivateKey();
  return { secret: bytesToHex(sk), holder: bytesToHex(ed25519.getPublicKey(sk)) };
}

export function holderOf(secret: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(secret)));
}

export function sign(secret: string, network: Network, fields: (string | bigint)[]): string {
  return b64url.enc(ed25519.sign(signedMessage(network, fields), hexToBytes(secret)));
}

function verify(holder: string, sig: string, network: Network, fields: (string | bigint)[]): boolean {
  const raw = b64url.dec(sig);
  if (!raw || raw.length !== 64) return false;
  try {
    return ed25519.verify(raw, signedMessage(network, fields), hexToBytes(holder));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ memos

const enc = (s: string) => encodeURIComponent(s);

export const memo = {
  deploy: (ticker: string, name: string, holder: string, feesToHolders: boolean, logo = "") =>
    [PROTOCOL, "deploy", ticker, enc(name), holder, feesToHolders ? "h" : "c", ...(logo ? [enc(logo)] : [])].join(" "),
  buy: (ticker: string, holder: string, minOut = 0n) => [PROTOCOL, "buy", ticker, holder, minOut].join(" "),
  sell(secret: string, network: Network, ticker: string, amount: bigint, minZat: bigint, payout: string, nonce: bigint) {
    const holder = holderOf(secret);
    const sig = sign(secret, network, ["sell", ticker, amount, minZat, payout, holder, nonce]);
    return [PROTOCOL, "sell", ticker, amount, minZat, payout, holder, nonce, sig].join(" ");
  },
  send(secret: string, network: Network, ticker: string, amount: bigint, to: string, nonce: bigint) {
    const holder = holderOf(secret);
    const sig = sign(secret, network, ["send", ticker, amount, to, holder, nonce]);
    return [PROTOCOL, "send", ticker, amount, to, holder, nonce, sig].join(" ");
  },
  claim(secret: string, network: Network, payout: string, nonce: bigint) {
    const holder = holderOf(secret);
    const sig = sign(secret, network, ["claim", payout, holder, nonce]);
    return [PROTOCOL, "claim", payout, holder, nonce, sig].join(" ");
  },
  paid: (payoutId: number) => [PROTOCOL, "paid", payoutId].join(" "),
};

const TICKER = /^[A-Z0-9]{2,8}$/;
const HOLDER = /^[0-9a-f]{64}$/;
const ADDRESS: Record<Network, RegExp> = {
  test: /^(utest1|ztestsapling1|tm)[0-9a-zA-Z]{20,400}$/,
  main: /^(u1|zs1|t1)[0-9a-zA-Z]{20,400}$/,
};

function uint(s: string | undefined): bigint | null {
  return s !== undefined && /^[0-9]{1,30}$/.test(s) ? BigInt(s) : null;
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

function addCredit(s: State, holder: string, zat: bigint) {
  if (zat > 0n) s.credit.set(holder, (s.credit.get(holder) ?? 0n) + zat);
}

function splitFee(s: State, coin: Coin, fee: bigint) {
  const pot = (fee * POT_BPS) / BPS;
  let toTreasury = fee - pot;
  if (pot > 0n) {
    if (!coin.feesToHolders) addCredit(s, coin.creator, pot);
    else if (coin.sold >= MIN_ELIGIBLE) coin.acc += (pot * ACC_PRECISION) / coin.sold;
    else toTreasury = fee;
  }
  s.treasuryZat += toTreasury;
}

function takeNonce(s: State, holder: string, nonce: bigint): boolean {
  if (nonce <= (s.nonces.get(holder) ?? 0n)) return false;
  s.nonces.set(holder, nonce);
  return true;
}

function buy(s: State, e: MemoEvent, coin: Coin, holder: string, zatIn: bigint, minOut: bigint): string | null {
  const q = quoteBuy(coin, zatIn);
  if (q.tokensOut === 0n || q.tokensOut < minOut) {
    addCredit(s, holder, zatIn); // nothing bought: the ZEC stays the buyer's
    return q.tokensOut === 0n ? "sold out or amount too small — credited" : "slippage — credited";
  }
  coin.vZat += q.forCurve;
  coin.vToken -= q.tokensOut;
  coin.realZat += q.forCurve;
  coin.sold += q.tokensOut;
  coin.volumeZat += zatIn - q.refund;
  coin.trades++;
  move(s, coin, holder, q.tokensOut);
  splitFee(s, coin, q.fee);
  addCredit(s, holder, q.refund);
  s.trades.push({
    ticker: coin.ticker, type: "buy", holder, zat: zatIn - q.refund, tokens: q.tokensOut, fee: q.fee,
    height: e.height, time: e.time, txid: e.txid,
  });
  return null;
}

/** Apply one memo. Returns a rejection reason, or null when it was folded in. */
function apply(s: State, p: Params, e: MemoEvent): string | null {
  const f = e.memo.trim().split(/\s+/);
  if (f[0] !== PROTOCOL) return "not a Notus memo";
  const cmd = f[1];

  if (e.fromDesk) {
    if (cmd !== "paid") return "desk memo ignored";
    const id = uint(f[2]);
    const po = id === null ? undefined : s.payouts[Number(id)];
    if (!po || po.paidTxid) return "unknown or already paid payout";
    if (e.valueZat < po.zat) return "payout underpaid";
    po.paidTxid = e.txid;
    return null;
  }
  if (cmd === "paid") return "only the desk confirms payouts";

  if (cmd === "deploy") {
    const [, , ticker, nameRaw, holder, mode, logoRaw] = f;
    const name = text(nameRaw, 32);
    const logo = text(logoRaw, 300);
    if (!ticker || !TICKER.test(ticker)) return "bad ticker";
    if (!name || logo === null) return "bad name or logo";
    if (!holder || !HOLDER.test(holder)) return "bad holder key";
    if (mode !== "c" && mode !== "h") return "bad fee mode";
    if (e.valueZat < p.deployFeeZat) return "deploy fee not covered";
    if (s.coins.has(ticker)) {
      addCredit(s, holder, e.valueZat); // late claim on a taken ticker: refundable
      return "ticker taken — credited";
    }
    const coin: Coin = {
      ticker, name, logo, creator: holder, feesToHolders: mode === "h",
      vZat: p.virtualZat, vToken: VIRTUAL_TOKEN, realZat: 0n, sold: 0n, acc: 0n,
      volumeZat: 0n, trades: 0, createdHeight: e.height, createdTime: e.time, txid: e.txid,
    };
    s.coins.set(ticker, coin);
    s.treasuryZat += p.deployFeeZat;
    const devBuy = e.valueZat - p.deployFeeZat;
    return devBuy > 0n ? buy(s, e, coin, holder, devBuy, 0n) : null;
  }

  if (cmd === "buy") {
    const [, , ticker, holder, minRaw] = f;
    if (!holder || !HOLDER.test(holder)) return "bad holder key";
    const coin = s.coins.get(ticker ?? "");
    const minOut = minRaw === undefined ? 0n : uint(minRaw);
    if (!coin || minOut === null) {
      addCredit(s, holder, e.valueZat);
      return "unknown coin or bad minimum — credited";
    }
    if (e.valueZat === 0n) return "no ZEC attached";
    return buy(s, e, coin, holder, e.valueZat, minOut);
  }

  if (cmd === "sell") {
    const [, , ticker, amountRaw, minRaw, payout, holder, nonceRaw, sig] = f;
    const coin = s.coins.get(ticker ?? "");
    const amount = uint(amountRaw), minZat = uint(minRaw), nonce = uint(nonceRaw);
    if (!coin || amount === null || minZat === null || nonce === null || amount === 0n) return "bad sell";
    if (!holder || !HOLDER.test(holder) || !payout || !ADDRESS[p.network].test(payout)) return "bad holder or payout address";
    if (!verify(holder, sig ?? "", p.network, ["sell", coin.ticker, amount, minZat, payout, holder, nonce])) return "bad signature";
    if (!takeNonce(s, holder, nonce)) return "stale nonce";
    if (get(s.balances, coin.ticker, holder) < amount) return "insufficient balance";
    const q = quoteSell(coin, amount);
    if (q.net < minZat) return "slippage";
    if (q.net < p.minPayoutZat) return "below the minimum payout";
    coin.vZat -= q.gross;
    coin.vToken += amount;
    coin.realZat -= q.gross;
    coin.sold -= amount;
    coin.volumeZat += q.gross;
    coin.trades++;
    move(s, coin, holder, -amount);
    splitFee(s, coin, q.fee);
    s.payouts.push({ id: s.payouts.length, kind: "sell", holder, to: payout, zat: q.net, height: e.height, txid: e.txid, paidTxid: null });
    s.trades.push({ ticker: coin.ticker, type: "sell", holder, zat: q.net, tokens: amount, fee: q.fee, height: e.height, time: e.time, txid: e.txid });
    addCredit(s, holder, e.valueZat); // the dust that carried the memo
    return null;
  }

  if (cmd === "send") {
    const [, , ticker, amountRaw, to, holder, nonceRaw, sig] = f;
    const coin = s.coins.get(ticker ?? "");
    const amount = uint(amountRaw), nonce = uint(nonceRaw);
    if (!coin || amount === null || nonce === null || amount === 0n) return "bad send";
    if (!holder || !HOLDER.test(holder) || !to || !HOLDER.test(to)) return "bad holder key";
    if (!verify(holder, sig ?? "", p.network, ["send", coin.ticker, amount, to, holder, nonce])) return "bad signature";
    if (!takeNonce(s, holder, nonce)) return "stale nonce";
    if (get(s.balances, coin.ticker, holder) < amount) return "insufficient balance";
    if (to !== holder) {
      move(s, coin, holder, -amount);
      move(s, coin, to, amount);
    }
    addCredit(s, holder, e.valueZat);
    return null;
  }

  if (cmd === "claim") {
    const [, , payout, holder, nonceRaw, sig] = f;
    const nonce = uint(nonceRaw);
    if (!holder || !HOLDER.test(holder) || nonce === null) return "bad claim";
    if (!payout || !ADDRESS[p.network].test(payout)) return "bad payout address";
    if (!verify(holder, sig ?? "", p.network, ["claim", payout, holder, nonce])) return "bad signature";
    if (!takeNonce(s, holder, nonce)) return "stale nonce";
    addCredit(s, holder, e.valueZat);
    let total = s.credit.get(holder) ?? 0n;
    for (const coin of s.coins.values()) {
      const bal = get(s.balances, coin.ticker, holder);
      settle(s, coin, holder, bal, bal);
      total += get(s.pending, coin.ticker, holder);
    }
    if (total < p.minPayoutZat) return "below the minimum payout"; // nothing is lost: it keeps accruing
    for (const coin of s.coins.values()) set(s.pending, coin.ticker, holder, 0n);
    s.credit.delete(holder);
    s.payouts.push({ id: s.payouts.length, kind: "claim", holder, to: payout, zat: total, height: e.height, txid: e.txid, paidTxid: null });
    return null;
  }

  return "unknown command";
}

/** Everything a holder could claim right now, in zatoshi. */
export function claimableZat(s: State, holder: string): bigint {
  let total = s.credit.get(holder) ?? 0n;
  for (const coin of s.coins.values()) {
    const entitled = (get(s.balances, coin.ticker, holder) * coin.acc) / ACC_PRECISION;
    const debt = get(s.debts, coin.ticker, holder);
    total += get(s.pending, coin.ticker, holder) + (entitled > debt ? entitled - debt : 0n);
  }
  return total;
}

/** ZEC the desk must hold to honour every coin, claim and unpaid payout. */
export function liabilitiesZat(s: State): bigint {
  let total = 0n;
  for (const c of s.coins.values()) total += c.realZat;
  const holders = new Set<string>(s.credit.keys());
  for (const m of s.balances.values()) for (const h of m.keys()) holders.add(h);
  for (const m of s.pending.values()) for (const h of m.keys()) holders.add(h);
  for (const h of holders) total += claimableZat(s, h);
  for (const po of s.payouts) if (!po.paidTxid) total += po.zat;
  return total;
}

export function replay(network: Network, events: MemoEvent[], params: Params = PARAMS[network]): State {
  const s = emptyState(network);
  const ordered = [...events].sort(
    (a, b) => a.height - b.height || a.txIndex - b.txIndex || a.outputIndex - b.outputIndex || (a.txid < b.txid ? -1 : 1)
  );
  let i = 0;
  while (i < ordered.length) {
    const height = ordered[i].height;
    for (; i < ordered.length && ordered[i].height === height; i++) {
      const e = ordered[i];
      s.memosRead++;
      const reason = apply(s, params, e);
      if (reason) s.rejected.push({ txid: e.txid, height: e.height, reason, memo: e.memo.slice(0, 120) });
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
      nonces: Object.fromEntries(sortedEntries(s.nonces)),
      treasuryZat: s.treasuryZat,
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
        memosRead: s.memosRead,
        treasuryZat: s.treasuryZat,
        liabilitiesZat: liabilitiesZat(s),
        coins: sortedEntries(s.coins).map(([, c]) => ({ ...c, holders: s.balances.get(c.ticker)?.size ?? 0 })),
        balances: nested(s.balances),
        claimable: Object.fromEntries(
          [...new Set([...s.credit.keys(), ...[...s.balances.values()].flatMap((m) => [...m.keys()])])]
            .sort()
            .map((h) => [h, claimableZat(s, h).toString()])
            .filter(([, v]) => v !== "0")
        ),
        nonces: Object.fromEntries(sortedEntries(s.nonces)),
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
