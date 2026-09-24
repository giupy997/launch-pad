// Notus on Litecoin — reading the chain.
//
// A minimal client for an Esplora-style block explorer API (mempool.space /
// Blockstream Esplora, as run for Litecoin by litecoinspace.org), and the
// one function that turns an explorer transaction into the event the ledger
// replays. The indexer uses it against the explorer directly; the browser
// through the site's /api/ltc proxy. The same events could be produced from
// a Litecoin Core node — the ledger does not care where they come from.

import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { addressOfPubkey, addressOfScript, opReturnPayload, DEFAULT_FEE_RATE, type Utxo } from "./tx.ts";
import type { Network, TxEvent } from "./ledger.ts";

export type EsploraVin = {
  txid: string;
  vout: number;
  prevout: { scriptpubkey: string; scriptpubkey_type: string; scriptpubkey_address?: string; value: number } | null;
  scriptsig?: string;
  witness?: string[];
  is_coinbase: boolean;
  sequence: number;
};
export type EsploraVout = { scriptpubkey: string; scriptpubkey_type: string; scriptpubkey_address?: string; value: number };
export type EsploraStatus = { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
export type EsploraTx = {
  txid: string;
  version: number;
  locktime: number;
  vin: EsploraVin[];
  vout: EsploraVout[];
  size: number;
  weight: number;
  fee: number;
  status: EsploraStatus;
};
export type EsploraUtxo = { txid: string; vout: number; value: number; status: EsploraStatus };

/** Public Esplora endpoints for Litecoin (the Litecoin Foundation's mempool fork). */
export const PUBLIC_API: Record<Network, string> = {
  main: "https://litecoinspace.org/api",
  test: "https://litecoinspace.org/testnet/api",
};
export const PUBLIC_EXPLORER: Record<Network, string> = {
  main: "https://litecoinspace.org",
  test: "https://litecoinspace.org/testnet",
};

export class Esplora {
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}/${path}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    const text = await r.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  tipHeight(): Promise<number> {
    return this.get<number>("blocks/tip/height").then(Number);
  }

  /** Confirmed transactions of an address, newest first, 25 per page. */
  addressTxsChain(address: string, lastSeenTxid?: string): Promise<EsploraTx[]> {
    return this.get(`address/${address}/txs/chain${lastSeenTxid ? `/${lastSeenTxid}` : ""}`);
  }

  addressTxsMempool(address: string): Promise<EsploraTx[]> {
    return this.get(`address/${address}/txs/mempool`);
  }

  tx(txid: string): Promise<EsploraTx> {
    return this.get(`tx/${txid}`);
  }

  txStatus(txid: string): Promise<EsploraStatus> {
    return this.get(`tx/${txid}/status`);
  }

  blockTxids(hash: string): Promise<string[]> {
    return this.get(`block/${hash}/txids`);
  }

  async utxos(address: string): Promise<Utxo[]> {
    const list = await this.get<EsploraUtxo[]>(`address/${address}/utxo`);
    return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: !!u.status?.confirmed }));
  }

  async broadcast(rawHex: string): Promise<string> {
    const r = await fetch(`${this.base}/tx`, { method: "POST", body: rawHex, headers: { "content-type": "text/plain" } });
    const text = (await r.text()).trim();
    if (!r.ok) throw new Error(`broadcast rejected: ${text.slice(0, 200)}`);
    return text.replace(/^"|"$/g, "");
  }

  /** Recommended fee rate in lit/vB, clamped to something sane. */
  async feeRate(): Promise<bigint> {
    try {
      const f = await this.get<{ hourFee?: number; halfHourFee?: number; fastestFee?: number }>("v1/fees/recommended");
      const v = Math.ceil(f.halfHourFee ?? f.hourFee ?? f.fastestFee ?? Number(DEFAULT_FEE_RATE));
      return BigInt(Math.min(500, Math.max(2, v)));
    } catch {
      return DEFAULT_FEE_RATE;
    }
  }
}

const PUBKEY = /^0[23][0-9a-f]{64}$/;

/** The compressed public key that signed an input, if it is a single-key
 *  script we understand and it really hashes to `sender`. Native segwit and
 *  P2SH-wrapped segwit carry it in the witness, legacy P2PKH in the scriptSig. */
export function senderPubkey(vin: EsploraVin, sender: string, network: Network): string | null {
  const type = vin.prevout?.scriptpubkey_type;
  let pub: string | undefined;
  if (type === "v0_p2wpkh" || type === "p2sh") pub = vin.witness?.[1];
  else if (type === "p2pkh" && vin.scriptsig) {
    try {
      const last = btc.Script.decode(hex.decode(vin.scriptsig)).at(-1);
      if (last instanceof Uint8Array) pub = hex.encode(last);
    } catch {}
  } else return null;
  if (!pub || !PUBKEY.test(pub)) return null;
  return addressOfPubkey(pub, type, network) === sender ? pub : null;
}

/** The ledger event for a confirmed transaction that involves the desk. */
export function eventFromTx(tx: EsploraTx, desk: string, network: Network, txIndex: number): TxEvent {
  if (!tx.status.confirmed || tx.status.block_height === undefined) throw new Error(`${tx.txid} is not confirmed`);
  const addr = (o: { scriptpubkey: string; scriptpubkey_address?: string }) => o.scriptpubkey_address ?? addressOfScript(o.scriptpubkey, network);
  const first = tx.vin[0];
  const sender = first && !first.is_coinbase && first.prevout ? addr(first.prevout) : null;
  const pubkey = sender ? senderPubkey(first, sender, network) : null;
  const fromDesk = tx.vin.some((i) => i.prevout && addr(i.prevout) === desk);
  const outputs = tx.vout.map((o) => {
    const address = o.scriptpubkey_type === "op_return" ? null : addr(o);
    return { address, lit: BigInt(o.value), toDesk: address === desk };
  });
  let valueLit = 0n;
  if (!fromDesk) for (const o of outputs) if (o.toDesk) valueLit += o.lit;
  const memoOut = tx.vout.find((o) => o.scriptpubkey_type === "op_return");
  return {
    height: tx.status.block_height,
    txIndex,
    txid: tx.txid,
    time: tx.status.block_time ?? 0,
    sender,
    senderPubkey: pubkey,
    outputs,
    valueLit,
    memo: memoOut ? opReturnPayload(memoOut.scriptpubkey) : null,
    fromDesk,
  };
}
