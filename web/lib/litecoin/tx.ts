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
import { MEMO_MAX_BYTES, memoBytes, type Network } from "./ledger.ts";

export type BtcNetwork = { bech32: string; pubKeyHash: number; scriptHash: number; wif: number };

/** Litecoin address parameters (Litecoin Core chainparams.cpp). */
export const NETWORKS: Record<Network, BtcNetwork> = {
  main: { bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
  test: { bech32: "tltc", pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef },
};

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

export function isAddress(address: string, network: Network): boolean {
  try {
    btc.Address(NETWORKS[network]).decode(address);
    return true;
  } catch {
    return false;
  }
}

/** The address an output script pays, or null for OP_RETURN and non-standard scripts. */
export function addressOfScript(scriptHex: string, network: Network): string | null {
  try {
    return btc.Address(NETWORKS[network]).encode(btc.OutScript.decode(hex.decode(scriptHex)));
  } catch {
    return null;
  }
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

export function sumLit(list: { value: bigint }[] | { lit: bigint }[]): bigint {
  let t = 0n;
  for (const x of list as ({ value?: bigint; lit?: bigint })[]) t += x.value ?? x.lit ?? 0n;
  return t;
}

/** Build and sign a transaction from the wallet's coins: the payments in
 *  order (so memo output pointers are stable), the OP_RETURN, and change.
 *  Coins are picked confirmed-first, then largest-first; the fee is
 *  measured on the signed transaction, not estimated. */
export function buildTx(opts: {
  network: Network;
  secret: string;
  utxos: Utxo[];
  payments: Payment[];
  memo?: string | null;
  feeRate?: bigint;
}): BuiltTx {
  const net = NETWORKS[opts.network];
  const wallet = walletFromSecret(opts.secret, opts.network);
  const priv = hex.decode(opts.secret);
  const feeRate = opts.feeRate ?? DEFAULT_FEE_RATE;
  const memoScript = opts.memo ? opReturnScript(opts.memo) : null;
  for (const p of opts.payments) {
    if (!isAddress(p.address, opts.network)) throw new Error(`bad address ${p.address}`);
    if (p.lit < DUST_LIT) throw new Error(`payment below dust (${DUST_LIT} lit)`);
  }
  const target = sumLit(opts.payments);
  const candidates = [...opts.utxos].sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  if (candidates.length === 0) throw new Error("the wallet has no coins");

  const assemble = (inputs: Utxo[], change: bigint) => {
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    for (const u of inputs) tx.addInput({ txid: hex.decode(u.txid), index: u.vout, witnessUtxo: { script: wallet.script, amount: u.value } });
    for (const p of opts.payments) tx.addOutputAddress(p.address, p.lit, net);
    if (memoScript) tx.addOutput({ script: memoScript, amount: 0n });
    if (change > 0n) tx.addOutputAddress(wallet.address, change, net);
    tx.sign(priv);
    tx.finalize();
    return tx;
  };

  const inputs: Utxo[] = [];
  let total = 0n;
  for (const u of candidates) {
    inputs.push(u);
    total += u.value;
    if (total <= target) continue;
    // measure the fee on a real signed transaction with a change output...
    const probe = assemble(inputs, total - target);
    const fee = BigInt(probe.vsize) * feeRate;
    const change = total - target - fee;
    if (change < 0n) continue; // this coin does not even cover the fee: add another
    // ...then build the one to broadcast, dropping change that would be dust
    const tx = change >= DUST_LIT ? assemble(inputs, change) : assemble(inputs, 0n);
    const finalChange = change >= DUST_LIT ? change : 0n;
    return {
      hex: tx.hex,
      txid: tx.id,
      fee: total - target - finalChange,
      vsize: tx.vsize,
      inputs: [...inputs],
      change: finalChange,
      outputs: [
        ...opts.payments.map((p) => ({ address: p.address, lit: p.lit })),
        ...(memoScript ? [{ address: null, lit: 0n }] : []),
        ...(finalChange > 0n ? [{ address: wallet.address, lit: finalChange }] : []),
      ],
    };
  }
  const short = target + BigInt(150 + 68 * candidates.length) * feeRate - total;
  throw new Error(`insufficient funds: about ${fmtLit(short)} LTC more needed`);
}

/** A parsed transaction's outputs, for checks and displays. */
export function parseTx(rawHex: string, network: Network): { txid: string; inputs: { txid: string; vout: number }[]; outputs: { address: string | null; lit: bigint; memo: string | null; script: string }[] } {
  const raw = btc.RawTx.decode(hex.decode(rawHex));
  const tx = btc.Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true });
  return {
    txid: tx.id,
    inputs: raw.inputs.map((i) => ({ txid: hex.encode(i.txid), vout: i.index })),
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
