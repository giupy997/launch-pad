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
import { addressOfPubkey, addressOfScript, opReturnPayload, parseTx, DEFAULT_FEE_RATE, type Utxo } from "./tx.ts";
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

/** Genesis block hashes: an endpoint that serves the other chain is never used. */
export const GENESIS: Record<Network, string> = {
  main: "12a765e31ffd4059bada1e25190f6e98c99d9714d334efa41a195a7e7e04bfe2",
  test: "4966625a4b2851d9fdee139e56211a0d88575f59ed816ff5e6a63deb4e3e29a0",
};
/** An explorer behind Cloudflare answers 5xx after up to 100s; give up sooner. */
export const TIMEOUT_MS = 45_000;

/** An explorer's answer that is an error. `status` < 500 is a real answer
 *  (unknown transaction, rejected broadcast); 5xx or none at all means the
 *  explorer, or the road to it, is down. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}
export const isFinal = (e: unknown) => e instanceof ApiError && e.status > 0 && e.status < 500;

export type Fees = { fastestFee: number; halfHourFee: number; hourFee: number };

/** What the ledger needs from a chain: Esplora's dialect, whoever serves it
 *  (Esplora itself, a Blockbook through the adapter, several in fallback). */
export abstract class ChainApi {
  /** Where this reads from, for logs. */
  abstract readonly label: string;
  abstract tipHeight(): Promise<number>;
  /** Hash of the block at `height` (0 = genesis: which chain is this?). */
  abstract blockHash(height: number): Promise<string>;
  /** Confirmed transactions of an address, newest first, PAGE per call;
   *  the next call passes the last txid seen. */
  abstract addressTxsChain(address: string, lastSeenTxid?: string): Promise<EsploraTx[]>;
  abstract addressTxsMempool(address: string): Promise<EsploraTx[]>;
  abstract tx(txid: string): Promise<EsploraTx>;
  abstract txStatus(txid: string): Promise<EsploraStatus>;
  abstract blockTxids(hash: string): Promise<string[]>;
  abstract rawUtxos(address: string): Promise<EsploraUtxo[]>;
  abstract broadcast(rawHex: string): Promise<string>;
  abstract fees(): Promise<Fees>;

  async utxos(address: string): Promise<Utxo[]> {
    const list = await this.rawUtxos(address);
    return list.map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), confirmed: !!u.status?.confirmed }));
  }

  /** Recommended fee rate in lit/vB, clamped to something sane. */
  async feeRate(): Promise<bigint> {
    try {
      const f = await this.fees();
      const v = Math.ceil(f.halfHourFee ?? f.hourFee ?? f.fastestFee ?? Number(DEFAULT_FEE_RATE));
      return BigInt(Math.min(500, Math.max(2, v)));
    } catch {
      return DEFAULT_FEE_RATE;
    }
  }
}
/** Esplora's page size for address/:addr/txs/chain. */
export const PAGE = 25;

/** An Esplora endpoint (mempool.space / Blockstream Esplora, as litecoinspace.org runs it). */
export class Esplora extends ChainApi {
  readonly base: string;
  readonly timeoutMs: number;
  constructor(base: string, timeoutMs = TIMEOUT_MS) {
    super();
    this.base = base.trim().replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  get label(): string {
    return this.base;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.base}/${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ApiError(`${path}: ${(e as Error).message}`);
    }
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.request(path);
    const text = await r.text();
    if (!r.ok) throw new ApiError(`${path}: HTTP ${r.status} ${text.slice(0, 120)}`, r.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  tipHeight(): Promise<number> {
    return this.get<number>("blocks/tip/height").then(Number);
  }

  blockHash(height: number): Promise<string> {
    return this.get<string>(`block-height/${height}`).then((h) => String(h).trim());
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

  rawUtxos(address: string): Promise<EsploraUtxo[]> {
    return this.get(`address/${address}/utxo`);
  }

  async broadcast(rawHex: string): Promise<string> {
    const r = await this.request("tx", { method: "POST", body: rawHex, headers: { "content-type": "text/plain" } });
    const text = (await r.text()).trim();
    if (r.ok) return text.replace(/^"|"$/g, "");
    // relayed already (by an endpoint that then failed, or by an earlier try): that is a success
    if (/already/i.test(text)) return txidOf(rawHex);
    throw new ApiError(`broadcast rejected: ${text.slice(0, 200)}`, r.status);
  }

  fees(): Promise<Fees> {
    return this.get("v1/fees/recommended");
  }
}

/** The id of a raw transaction (what a broadcast would have answered). */
export function txidOf(rawHex: string): string {
  return parseTx(rawHex, "main").txid; // the network only matters for addresses, not the id
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

/** An instruction still waiting for a block: what the site shows as pending.
 *  Nothing here is folded into the ledger — it is only a heads-up. */
export type PendingTx = { txid: string; sender: string | null; valueLit: bigint; memo: string | null; seen: number };

export function pendingFromTx(tx: EsploraTx, desk: string, network: Network, seen = Math.floor(Date.now() / 1000)): PendingTx | null {
  const addr = (o: { scriptpubkey: string; scriptpubkey_address?: string }) => o.scriptpubkey_address ?? addressOfScript(o.scriptpubkey, network);
  if (tx.vin.some((i) => i.prevout && addr(i.prevout) === desk)) return null; // the desk's own payouts are not instructions
  const first = tx.vin[0];
  let valueLit = 0n;
  for (const o of tx.vout) if (o.scriptpubkey_type !== "op_return" && addr(o) === desk) valueLit += BigInt(o.value);
  const memoOut = tx.vout.find((o) => o.scriptpubkey_type === "op_return");
  return {
    txid: tx.txid,
    sender: first && !first.is_coinbase && first.prevout ? addr(first.prevout) : null,
    valueLit,
    memo: memoOut ? opReturnPayload(memoOut.scriptpubkey) : null,
    seen,
  };
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
