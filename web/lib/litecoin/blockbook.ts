// Notus on Litecoin — a Blockbook explorer (Trezor's software; public
// Litecoin instances such as litecoinblockexplorer.net, or NowNodes with a
// key) read through Esplora's dialect, so the ledger has a second kind of
// backend when litecoinspace.org is down.
//
// Blockbook's transactions come with prevout addresses and values and, on
// the /tx endpoint, the raw hex; the raw hex parsed by our own parser gives
// the witnesses (public keys) and output scripts Esplora would have listed.
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import {
  ApiError,
  ChainApi,
  PAGE,
  TIMEOUT_MS,
  isFinal,
  txidOf,
  type EsploraStatus,
  type EsploraTx,
  type EsploraUtxo,
  type EsploraVin,
  type EsploraVout,
  type Fees,
} from "./esplora.ts";
import { NETWORKS, addressOfScript, parseTx } from "./tx.ts";
import type { Network } from "./ledger.ts";

type BbVin = { txid?: string; vout?: number; sequence?: number; n: number; addresses?: string[]; isAddress?: boolean; value?: string; hex?: string; coinbase?: string };
type BbVout = { value?: string; n: number; hex?: string; addresses?: string[]; isAddress?: boolean };
export type BbTx = {
  txid: string;
  version?: number;
  lockTime?: number;
  vin: BbVin[];
  vout: BbVout[];
  blockHash?: string;
  blockHeight?: number; // -1 in the mempool
  confirmations?: number;
  blockTime?: number;
  size?: number;
  vsize?: number;
  fees?: string;
  hex?: string;
};
type BbAddress = { page?: number; totalPages?: number; transactions?: BbTx[] };
type BbUtxo = { txid: string; vout?: number; value: string; height?: number; confirmations?: number };
type BbBlock = { page?: number; totalPages?: number; txs?: { txid: string }[] };

/** Transactions per Blockbook page we ask for (it serves up to 1000). */
const SIZE = 50;

/** Esplora's name for an output script. */
export function scriptType(scriptHex: string): string {
  if (/^6a/.test(scriptHex)) return "op_return";
  if (/^0014[0-9a-f]{40}$/.test(scriptHex)) return "v0_p2wpkh";
  if (/^0020[0-9a-f]{64}$/.test(scriptHex)) return "v0_p2wsh";
  if (/^5120[0-9a-f]{64}$/.test(scriptHex)) return "v1_p2tr";
  if (/^76a914[0-9a-f]{40}88ac$/.test(scriptHex)) return "p2pkh";
  if (/^a914[0-9a-f]{40}87$/.test(scriptHex)) return "p2sh";
  return "unknown";
}

/** The script an address stands for, or null if it is not one of ours. */
export function scriptOfAddress(address: string, network: Network): string | null {
  try {
    return hex.encode(btc.OutScript.encode(btc.Address(NETWORKS[network]).decode(address)));
  } catch {
    return null;
  }
}

export class Blockbook extends ChainApi {
  readonly base: string;
  readonly network: Network;
  readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  /** Where each confirmed transaction sat in an address listing when we last walked it. */
  private walk = new Map<string, { page: number; i: number }>();
  /** Confirmed transactions already translated (a listing without raw hex
   *  costs one more call per transaction; a mined one never changes). */
  private done = new Map<string, EsploraTx>();

  constructor(base: string, network: Network, apiKey?: string, timeoutMs = TIMEOUT_MS) {
    super();
    this.base = base.trim().replace(/\/$/, "");
    this.network = network;
    this.timeoutMs = timeoutMs;
    this.headers = apiKey ? { "api-key": apiKey } : {};
  }

  private async get<T>(path: string, init: RequestInit = {}): Promise<T> {
    let r: Response;
    try {
      r = await fetch(path ? `${this.base}/${path}` : this.base, {
        ...init,
        headers: { ...this.headers, ...((init.headers as Record<string, string> | undefined) ?? {}) },
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ApiError(`${path || "status"}: ${(e as Error).message}`);
    }
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    const err = (body as { error?: { message?: string } | string } | null)?.error;
    if (!r.ok || err) {
      const msg = typeof err === "string" ? err : err?.message ?? text.slice(0, 120);
      throw new ApiError(`${path || "status"}: ${r.ok ? "" : `HTTP ${r.status} `}${msg}`, r.ok ? 400 : r.status);
    }
    return body as T;
  }

  async tipHeight(): Promise<number> {
    const s = await this.get<{ blockbook?: { bestHeight?: number }; backend?: { blocks?: number } }>("");
    const h = s.blockbook?.bestHeight ?? s.backend?.blocks;
    if (!h) throw new ApiError("status: no height", 502);
    return h;
  }

  async blockHash(height: number): Promise<string> {
    const r = await this.get<{ blockHash?: string }>(`block-index/${height}`);
    if (!r.blockHash) throw new ApiError(`block-index/${height}: no such block`, 404);
    return r.blockHash;
  }

  private listing(address: string, page: number): Promise<BbAddress> {
    return this.get<BbAddress>(`address/${address}?details=txs&pageSize=${SIZE}&page=${page}`);
  }

  /** Esplora pages by "the last txid you saw"; Blockbook by number. We
   *  remember where each txid sat, and rescan from the top if it moved. */
  async addressTxsChain(address: string, lastSeenTxid?: string): Promise<EsploraTx[]> {
    let page = 1;
    let from = 0;
    let collecting = !lastSeenTxid;
    const pos = lastSeenTxid ? this.walk.get(`${address}:${lastSeenTxid}`) : undefined;
    const out: EsploraTx[] = [];
    for (;;) {
      if (pos && page === 1 && from === 0 && !collecting) {
        const r = await this.listing(address, pos.page);
        if (r.transactions?.[pos.i]?.txid === lastSeenTxid) {
          page = pos.page;
          from = pos.i + 1;
          collecting = true;
          await this.collect(address, r, page, from, out);
          if (out.length >= PAGE || page >= (r.totalPages ?? 1)) return out;
          page++;
          from = 0;
          continue;
        }
      }
      const r = await this.listing(address, page);
      const list = r.transactions ?? [];
      if (!collecting) {
        const at = list.findIndex((t) => t.txid === lastSeenTxid);
        if (at >= 0) {
          collecting = true;
          from = at + 1;
        }
      }
      if (collecting) await this.collect(address, r, page, from, out);
      if (out.length >= PAGE || page >= (r.totalPages ?? 1) || list.length === 0) return out;
      page++;
      from = 0;
    }
  }

  private async collect(address: string, r: BbAddress, page: number, from: number, out: EsploraTx[]) {
    const list = r.transactions ?? [];
    for (let i = from; i < list.length && out.length < PAGE; i++) {
      const t = list[i];
      if ((t.blockHeight ?? -1) < 0) continue; // still in the mempool
      this.walk.set(`${address}:${t.txid}`, { page, i });
      out.push(await this.toEsplora(t));
    }
  }

  async addressTxsMempool(address: string): Promise<EsploraTx[]> {
    const out: EsploraTx[] = [];
    for (let page = 1; ; page++) {
      const r = await this.listing(address, page);
      const list = r.transactions ?? [];
      let allPending = list.length > 0;
      for (const t of list) {
        if ((t.blockHeight ?? -1) >= 0) {
          allPending = false;
          break; // the mempool leads the listing: the rest is confirmed
        }
        out.push(await this.toEsplora(t));
      }
      if (!allPending || page >= (r.totalPages ?? 1)) return out;
    }
  }

  async tx(txid: string): Promise<EsploraTx> {
    return this.toEsplora(await this.get<BbTx>(`tx/${txid}`));
  }

  async txStatus(txid: string): Promise<EsploraStatus> {
    return (await this.tx(txid)).status;
  }

  async blockTxids(hash: string): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const b = await this.get<BbBlock>(`block/${hash}?page=${page}`);
      ids.push(...(b.txs ?? []).map((t) => t.txid));
      if (page >= (b.totalPages ?? 1)) return ids;
    }
  }

  async rawUtxos(address: string): Promise<EsploraUtxo[]> {
    const list = await this.get<BbUtxo[]>(`utxo/${address}?confirmed=false`);
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout ?? 0,
      value: Number(u.value),
      status: (u.confirmations ?? 0) > 0 ? { confirmed: true, block_height: u.height } : { confirmed: false },
    }));
  }

  async broadcast(rawHex: string): Promise<string> {
    try {
      const r = await this.get<{ result?: string }>("sendtx/", { method: "POST", body: rawHex, headers: { "content-type": "text/plain" } });
      if (!r.result) throw new ApiError("sendtx: no result", 502);
      return r.result;
    } catch (e) {
      // relayed already (by an endpoint that then failed, or by an earlier try): that is a success
      if (isFinal(e) && /already/i.test((e as Error).message)) return txidOf(rawHex);
      throw e;
    }
  }

  /** Blockbook estimates in LTC per kB; Esplora's numbers are lit/vB. */
  async fees(): Promise<Fees> {
    const r = await this.get<{ result?: string }>("estimatefee/2");
    const perKb = Number(r.result);
    if (!(perKb > 0)) throw new ApiError("estimatefee: no estimate", 502);
    const litPerVb = (perKb * 1e8) / 1000;
    return { fastestFee: litPerVb, halfHourFee: litPerVb, hourFee: litPerVb };
  }

  /** Blockbook's transaction as Esplora would list it. */
  async toEsplora(t: BbTx): Promise<EsploraTx> {
    const key = t.blockHash ? `${t.txid}:${t.blockHash}` : null;
    const known = key ? this.done.get(key) : undefined;
    if (known) return known;
    const raw = t.hex ?? (await this.get<BbTx>(`tx/${t.txid}`)).hex;
    const parsed = raw ? parseTx(raw, this.network) : null;
    const vin: EsploraVin[] = t.vin.map((v, n) => {
      const address = v.isAddress === false ? undefined : v.addresses?.[0];
      const script = address ? scriptOfAddress(address, this.network) : null;
      return {
        txid: v.txid ?? "0".repeat(64),
        vout: v.vout ?? 0,
        prevout:
          script && v.value !== undefined
            ? { scriptpubkey: script, scriptpubkey_type: scriptType(script), scriptpubkey_address: address, value: Number(v.value) }
            : null,
        scriptsig: v.hex ?? "",
        witness: parsed?.inputs[n]?.witness ?? [],
        is_coinbase: !v.txid || v.coinbase !== undefined,
        sequence: v.sequence ?? 0xffffffff,
      };
    });
    const vout: EsploraVout[] = t.vout.map((o, n) => {
      const script = o.hex ?? parsed?.outputs[n]?.script ?? "";
      const address = (o.isAddress === false ? undefined : o.addresses?.[0]) ?? addressOfScript(script, this.network) ?? undefined;
      return { scriptpubkey: script, scriptpubkey_type: scriptType(script), scriptpubkey_address: address, value: Number(o.value ?? 0) };
    });
    const confirmed = (t.blockHeight ?? -1) > 0 || !!t.blockHash;
    const tx: EsploraTx = {
      txid: t.txid,
      version: t.version ?? 1,
      locktime: t.lockTime ?? 0,
      vin,
      vout,
      size: t.size ?? 0,
      weight: (t.vsize ?? t.size ?? 0) * 4,
      fee: Number(t.fees ?? 0),
      status: confirmed ? { confirmed: true, block_height: t.blockHeight, block_hash: t.blockHash, block_time: t.blockTime } : { confirmed: false },
    };
    if (key && confirmed) {
      if (this.done.size > 5000) this.done.clear();
      this.done.set(key, tx);
    }
    return tx;
  }
}
