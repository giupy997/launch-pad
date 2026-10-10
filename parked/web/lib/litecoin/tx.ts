// Notus on Litecoin — transactions.
//
// Everything a person does here is an ordinary Litecoin transaction: it
// pays the desk, carries the instruction in an OP_RETURN output, and is
// signed by the key that owns the coins being spent. This file builds those
// transactions, for the browser wallet and for the desk's own payout script
// alike, with @scure/btc-signer and Litecoin's network parameters (from
// Litecoin Core's chainparams.cpp). Nothing here touches the network.

import * as btc from "@scure/btc-signer";
import { hex, utf8 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { MEMO_MAX_BYTES, memoBytes, type Network } from "./ledger.ts";
import { NETWORKS, addressOfScript, isAddress, type BtcNetwork } from "./address.ts";

export { NETWORKS, addressOfScript, isAddress };
export type { BtcNetwork };

/** Litecoin Core's dust relay fee is 30 000 lit/kB (10x Bitcoin's): a P2PKH
 *  output under 5 460 lit, or a P2WPKH one under 2 940, is not relayed. */
export const DUST_LIT = 6_000n;
/** What an instruction that carries no payment (sell, send, claim) pays the
 *  desk so that the transaction reaches it. Credited back to the sender. */
export const CARRY_LIT = 10_000n;
/** Fee rate used when the explorer offers no estimate (min relay is 1 lit/vB). */
export const DEFAULT_FEE_RATE = 10n;

export type Utxo = { txid: string; vout: number; value: bigint; confirmed: boolean };
export type Payment = { address: string; lit: bigint };

export type Wallet = { address: string; script: Uint8Array; publicKey: Uint8Array; wif: string };

export function newSecret(): string {
  return hex.encode(btc.utils.randomPrivateKeyBytes());
}

export function isSecret(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s) && secp256k1.utils.isValidPrivateKey(hex.decode(s));
}

/** A native-segwit (P2WPKH) wallet from a 32-byte secret. */
export function walletFromSecret(secret: string, network: Network): Wallet {
  const priv = hex.decode(secret);
  const publicKey = secp256k1.getPublicKey(priv, true);
  const p = btc.p2wpkh(publicKey, NETWORKS[network]);
  return { address: p.address!, script: p.script, publicKey, wif: btc.WIF(NETWORKS[network]).encode(priv) };
}

/** Secret from a WIF (Electrum-LTC, Litecoin Core), for restores. */
export function secretFromWif(wif: string, network: Network): string | null {
  try {
    return hex.encode(btc.WIF(NETWORKS[network]).decode(wif.trim()));
  } catch {
    return null;
  }
}

/** The address a compressed public key spends from, per input script type
 *  (Esplora's names): native segwit, legacy, or segwit wrapped in P2SH. */
export function addressOfPubkey(pubkeyHex: string, scriptType: "v0_p2wpkh" | "p2pkh" | "p2sh", network: Network): string | null {
  try {
    const pub = hex.decode(pubkeyHex);
    const net = NETWORKS[network];
    if (scriptType === "v0_p2wpkh") return btc.p2wpkh(pub, net).address ?? null;
    if (scriptType === "p2pkh") return btc.p2pkh(pub, net).address ?? null;
    return btc.p2sh(btc.p2wpkh(pub, net), net).address ?? null;
  } catch {
    return null;
  }
}

/** Litecoin and EVM chains share secp256k1: the same key is an EVM account.
 *  Its address is the last 20 bytes of keccak256(uncompressed public key),
 *  EIP-55 checksummed. This is where a holder's coins land on LitVM. */
export function evmAddressOfPubkey(pubkeyHex: string): string {
  const raw = secp256k1.ProjectivePoint.fromHex(pubkeyHex).toRawBytes(false).slice(1); // x || y
  const addr = hex.encode(keccak_256(raw).slice(-20));
  const check = hex.encode(keccak_256(utf8.decode(addr)));
  let out = "0x";
  for (let i = 0; i < addr.length; i++) out += parseInt(check[i], 16) >= 8 ? addr[i].toUpperCase() : addr[i];
  return out;
}

export function evmAddressOfSecret(secret: string): string {
  return evmAddressOfPubkey(hex.encode(secp256k1.getPublicKey(hex.decode(secret), true)));
}

/** Text carried by an OP_RETURN script (one push), or null. */
export function opReturnPayload(scriptHex: string): string | null {
  try {
    const parts = btc.Script.decode(hex.decode(scriptHex));
    if (parts.length !== 2 || parts[0] !== "RETURN" || !(parts[1] instanceof Uint8Array)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(parts[1]);
  } catch {
    return null;
  }
}

export function opReturnScript(memo: string): Uint8Array {
  if (memoBytes(memo) > MEMO_MAX_BYTES) throw new Error(`memo over ${MEMO_MAX_BYTES} bytes`);
  return btc.Script.encode(["RETURN", utf8.decode(memo)]);
}

export type BuiltTx = {
  hex: string;
  txid: string;
  fee: bigint;
  vsize: number;
  inputs: Utxo[];
  /** Change returned to the wallet (0 when it would have been dust). */
  change: bigint;
  /** Every output in order: the payments, then the memo (address null), then any change. */
  outputs: { address: string | null; lit: bigint }[];
};

/** The same transaction for a wallet that signs elsewhere (a browser
 *  extension): the PSBT to hand it, with the picture of what it does. */
export type UnsignedTx = Omit<BuiltTx, "hex" | "txid"> & {
  /** The unsigned PSBT, hex, every input carrying its coin (witness UTXO). */
  psbt: string;
  /** The inputs the wallet signs (all of them), each with the address it spends from. */
  toSign: { index: number; address: string }[];
  memo: string | null;
};

/** The coins the builder can spend: those a single key owns through native
 *  segwit (the browser wallet's kind), taproot or segwit wrapped in P2SH, as
 *  extensions offer them. Legacy (P2PKH) coins need the whole previous
 *  transaction in the PSBT and are not offered. */
export type InputKind = "wpkh" | "tr" | "sh-wpkh";

/** What every input of a wallet's transactions carries. */
type Spender = { address: string; kind: InputKind; script: Uint8Array; redeemScript?: Uint8Array; tapInternalKey?: Uint8Array };

function spenderOfPubkey(pub: Uint8Array, kind: InputKind, network: Network): Spender {
  const net = NETWORKS[network];
  if (kind === "wpkh") {
    const p = btc.p2wpkh(pub, net);
    return { address: p.address!, kind, script: p.script };
  }
  if (kind === "tr") {
    const p = btc.p2tr(pub.slice(1), undefined, net);
    return { address: p.address!, kind, script: p.script, tapInternalKey: pub.slice(1) };
  }
  const p = btc.p2sh(btc.p2wpkh(pub, net), net);
  return { address: p.address!, kind, script: p.script, redeemScript: p.redeemScript };
}

/** The kind of coins `address` holds given the compressed key behind it, or
 *  null when it is not one of the kinds above (or not this key's address). */
export function inputKindOf(address: string, pubkeyHex: string, network: Network): InputKind | null {
  let pub: Uint8Array;
  try {
    pub = hex.decode(pubkeyHex);
  } catch {
    return null;
  }
  if (pub.length !== 33) return null;
  for (const kind of ["wpkh", "tr", "sh-wpkh"] as const) {
    try {
      if (spenderOfPubkey(pub, kind, network).address === address) return kind;
    } catch {}
  }
  return null;
}

export function sumLit(list: { value: bigint }[] | { lit: bigint }[]): bigint {
  let t = 0n;
  for (const x of list as ({ value?: bigint; lit?: bigint })[]) t += x.value ?? x.lit ?? 0n;
  return t;
}

export type BuildOpts = {
  network: Network;
  utxos: Utxo[];
  payments: Payment[];
  memo?: string | null;
  feeRate?: bigint;
  /** Coins the transaction must spend, whatever else it picks: a fee bump
   *  has to conflict with the transaction it replaces. */
  mustSpend?: Utxo[];
  /** Signal BIP125 replaceability, so a stuck transaction can be fee-bumped. */
  rbf?: boolean;
};

/** The transaction itself, unsigned: the coins, the payments in order (so
 *  memo output pointers are stable), the OP_RETURN, and change. */
function assemble(sp: Spender, o: BuildOpts, memoScript: Uint8Array | null, inputs: Utxo[], change: bigint): btc.Transaction {
  const net = NETWORKS[o.network];
  const sequence = o.rbf ? 0xfffffffd : undefined;
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  for (const u of inputs) {
    tx.addInput({
      txid: hex.decode(u.txid),
      index: u.vout,
      sequence,
      witnessUtxo: { script: sp.script, amount: u.value },
      ...(sp.redeemScript ? { redeemScript: sp.redeemScript } : {}),
      ...(sp.tapInternalKey ? { tapInternalKey: sp.tapInternalKey } : {}),
    });
  }
  for (const p of o.payments) tx.addOutputAddress(p.address, p.lit, net);
  if (memoScript) tx.addOutput({ script: memoScript, amount: 0n });
  if (change > 0n) tx.addOutputAddress(sp.address, change, net);
  return tx;
}

/** Coin selection: forced coins first, then confirmed-first and
 *  largest-first, until the coins cover the payments and the fee, which is
 *  measured (by `vsizeOf`) on a real signed transaction, not estimated. */
function plan(o: BuildOpts, sp: Spender, memoScript: Uint8Array | null, vsizeOf: (inputs: Utxo[], change: bigint) => number) {
  const feeRate = o.feeRate ?? DEFAULT_FEE_RATE;
  for (const p of o.payments) {
    if (!isAddress(p.address, o.network)) throw new Error(`bad address ${p.address}`);
    if (p.lit < DUST_LIT) throw new Error(`payment below dust (${DUST_LIT} lit)`);
  }
  const target = sumLit(o.payments);
  const must = o.mustSpend ?? [];
  const key = (u: Utxo) => `${u.txid}:${u.vout}`;
  const forced = new Set(must.map(key));
  const candidates = [
    ...must,
    ...[...o.utxos].filter((u) => !forced.has(key(u))).sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || (b.value > a.value ? 1 : b.value < a.value ? -1 : 0)),
  ];
  if (candidates.length === 0) throw new Error("the wallet has no coins");

  const inputs: Utxo[] = [];
  let total = 0n;
  for (const u of candidates) {
    inputs.push(u);
    total += u.value;
    if (inputs.length < must.length) continue; // every forced coin goes in first
    if (total <= target) continue;
    // measure the fee on a transaction with a change output...
    const fee = BigInt(vsizeOf(inputs, total - target)) * feeRate;
    const change = total - target - fee;
    if (change < 0n) continue; // this coin does not even cover the fee: add another
    // ...then keep the change only when it is not dust (else it goes to the fee)
    const finalChange = change >= DUST_LIT ? change : 0n;
    return {
      inputs: [...inputs],
      change: finalChange,
      fee: total - target - finalChange,
      outputs: [
        ...o.payments.map((p) => ({ address: p.address as string | null, lit: p.lit })),
        ...(memoScript ? [{ address: null as string | null, lit: 0n }] : []),
        ...(finalChange > 0n ? [{ address: sp.address as string | null, lit: finalChange }] : []),
      ],
    };
  }
  const short = target + BigInt(150 + 68 * candidates.length) * feeRate - total;
  throw new Error(`insufficient funds: about ${fmtLit(short)} LTC more needed`);
}

/** Build and sign a transaction from the browser wallet's coins. */
export function buildTx(opts: BuildOpts & { secret: string }): BuiltTx {
  const priv = hex.decode(opts.secret);
  const sp = spenderOfPubkey(secp256k1.getPublicKey(priv, true), "wpkh", opts.network);
  const memoScript = opts.memo ? opReturnScript(opts.memo) : null;
  const signed = (inputs: Utxo[], change: bigint) => {
    const tx = assemble(sp, opts, memoScript, inputs, change);
    tx.sign(priv);
    tx.finalize();
    return tx;
  };
  const p = plan(opts, sp, memoScript, (inputs, change) => signed(inputs, change).vsize);
  const tx = signed(p.inputs, p.change);
  return { hex: tx.hex, txid: tx.id, fee: p.fee, vsize: tx.vsize, inputs: p.inputs, change: p.change, outputs: p.outputs };
}

/** A throwaway key for measuring: a transaction signed by it is the size of
 *  the one the wallet will sign, whatever the key (one signature per input).
 *  Drawn at random each time the module loads: a fixed one would be a key
 *  anybody could read, and coins sent to its address by mistake anybody's. */
const PROBE_KEY = secp256k1.utils.randomPrivateKey();

/** The same transaction for a wallet that signs elsewhere: coins picked and
 *  fee set as for the browser wallet, measured on a look-alike signed with a
 *  throwaway key of the same kind, and returned as a PSBT for the wallet. */
export function buildUnsigned(opts: BuildOpts & { address: string; pubkey: string }): UnsignedTx {
  const kind = inputKindOf(opts.address, opts.pubkey, opts.network);
  if (!kind) throw new Error("this wallet's address type is not supported here: switch it to Native Segwit or Taproot in the extension");
  const sp = spenderOfPubkey(hex.decode(opts.pubkey), kind, opts.network);
  const probe = spenderOfPubkey(secp256k1.getPublicKey(PROBE_KEY, true), kind, opts.network);
  const memoScript = opts.memo ? opReturnScript(opts.memo) : null;
  const lookAlike = (inputs: Utxo[], change: bigint) => {
    const tx = assemble(probe, opts, memoScript, inputs, change);
    tx.sign(PROBE_KEY);
    tx.finalize();
    return tx;
  };
  const p = plan(opts, sp, memoScript, (inputs, change) => lookAlike(inputs, change).vsize);
  const tx = assemble(sp, opts, memoScript, p.inputs, p.change);
  return {
    psbt: hex.encode(tx.toPSBT()),
    toSign: p.inputs.map((_, index) => ({ index, address: sp.address })),
    memo: opts.memo ?? null,
    fee: p.fee,
    vsize: lookAlike(p.inputs, p.change).vsize,
    inputs: p.inputs,
    change: p.change,
    outputs: p.outputs,
  };
}

/** The signed PSBT back from the wallet, checked to be the transaction that
 *  was handed over (same coins, same outputs, same memo), finalized and
 *  extracted, ready to broadcast. */
export function finishSigned(psbtHex: string, unsigned: UnsignedTx, network: Network): { hex: string; txid: string } {
  const tx = btc.Transaction.fromPSBT(hex.decode(psbtHex), { allowUnknownOutputs: true });
  const differs = () => new Error("the wallet returned a different transaction; nothing was sent");
  if (tx.inputsLength !== unsigned.inputs.length || tx.outputsLength !== unsigned.outputs.length) throw differs();
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    if (!inp.txid || hex.encode(inp.txid) !== unsigned.inputs[i].txid || inp.index !== unsigned.inputs[i].vout) throw differs();
  }
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    const want = unsigned.outputs[i];
    if (!out.script || out.amount !== want.lit) throw differs();
    const script = hex.encode(out.script);
    if (addressOfScript(script, network) !== want.address) throw differs();
    if (want.address === null && opReturnPayload(script) !== unsigned.memo) throw differs();
  }
  if (!tx.isFinal) tx.finalize();
  return { hex: hex.encode(tx.extract()), txid: tx.id };
}

/** A parsed transaction's outputs, for checks and displays. */
export function parseTx(rawHex: string, network: Network): { txid: string; inputs: { txid: string; vout: number; witness: string[] }[]; outputs: { address: string | null; lit: bigint; memo: string | null; script: string }[] } {
  const raw = btc.RawTx.decode(hex.decode(rawHex));
  const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  return {
    txid: tx.id,
    inputs: raw.inputs.map((i, n) => ({ txid: hex.encode(i.txid), vout: i.index, witness: (raw.witnesses?.[n] ?? []).map((w) => hex.encode(w)) })),
    outputs: raw.outputs.map((o) => {
      const script = hex.encode(o.script);
      return { address: addressOfScript(script, network), lit: o.amount, memo: opReturnPayload(script), script };
    }),
  };
}

export function fmtLit(lit: bigint, digits = 8): string {
  const n = Number(lit) / 1e8;
  return n.toFixed(digits).replace(/\.?0+$/, "") || "0";
}
