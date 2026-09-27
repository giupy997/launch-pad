// Notus on Litecoin — which explorer(s) to read the chain through.
//
//   NOTUS_LTC_API=https://litecoinspace.org/api                       one Esplora endpoint
//   NOTUS_LTC_API=https://litecoinspace.org/api,https://ltc1.trezor.io/api/v2
//                                                                      …with a Blockbook one as fallback
//
// Several endpoints are tried in order: a timeout or a 5xx moves on to the
// next, a real answer (unknown transaction, rejected broadcast) does not.
// An endpoint that turns out to serve the other chain is never used: its
// genesis block says which chain it is.
import { ApiError, ChainApi, Esplora, GENESIS, TIMEOUT_MS, isFinal, type EsploraStatus, type EsploraTx, type EsploraUtxo, type Fees } from "./esplora.ts";
import { Blockbook } from "./blockbook.ts";
import type { Network } from "./ledger.ts";

export class Fallback extends ChainApi {
  readonly backends: ChainApi[];
  readonly network: Network;
  private chain = new Map<ChainApi, boolean>();
  constructor(backends: ChainApi[], network: Network) {
    super();
    this.backends = backends;
    this.network = network;
  }

  /** Only a positive match with the other chain rules an endpoint out; one
   *  that cannot answer the question is left to fail on its own. */
  private async usable(b: ChainApi): Promise<boolean> {
    if (this.backends.length === 1) return true;
    const known = this.chain.get(b);
    if (known !== undefined) return known;
    try {
      const h = (await b.blockHash(0)).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(h)) return true;
      const ok = h !== GENESIS[this.network === "main" ? "test" : "main"];
      this.chain.set(b, ok);
      return ok;
    } catch {
      return true;
    }
  }

  private async run<T>(f: (b: ChainApi) => Promise<T>): Promise<T> {
    let last: unknown = null;
    for (const b of this.backends) {
      if (!(await this.usable(b))) continue;
      try {
        return await f(b);
      } catch (e) {
        if (isFinal(e)) throw e;
        last = e;
      }
    }
    throw last ?? new ApiError("no explorer endpoint on this chain");
  }

  tipHeight(): Promise<number> {
    return this.run((b) => b.tipHeight());
  }
  blockHash(height: number): Promise<string> {
    return this.run((b) => b.blockHash(height));
  }
  addressTxsChain(address: string, lastSeenTxid?: string): Promise<EsploraTx[]> {
    return this.run((b) => b.addressTxsChain(address, lastSeenTxid));
  }
  addressTxsMempool(address: string): Promise<EsploraTx[]> {
    return this.run((b) => b.addressTxsMempool(address));
  }
  tx(txid: string): Promise<EsploraTx> {
    return this.run((b) => b.tx(txid));
  }
  txStatus(txid: string): Promise<EsploraStatus> {
    return this.run((b) => b.txStatus(txid));
  }
  blockTxids(hash: string): Promise<string[]> {
    return this.run((b) => b.blockTxids(hash));
  }
  rawUtxos(address: string): Promise<EsploraUtxo[]> {
    return this.run((b) => b.rawUtxos(address));
  }
  broadcast(rawHex: string): Promise<string> {
    return this.run((b) => b.broadcast(rawHex));
  }
  fees(): Promise<Fees> {
    return this.run((b) => b.fees());
  }
}

/** True for a Blockbook base URL (…/api/v2); anything else is taken as Esplora. */
export const isBlockbook = (base: string) => /\/api\/v2\/?$/.test(base.trim());

/** The explorer(s) a comma-separated spec names. `apiKey` goes to Blockbook
 *  endpoints only (NowNodes wants one in an `api-key` header). */
export function chainApi(spec: string, network: Network, apiKey?: string, timeoutMs = TIMEOUT_MS): ChainApi {
  const backends = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (isBlockbook(s) ? new Blockbook(s, network, apiKey, timeoutMs) : new Esplora(s, timeoutMs)));
  if (backends.length === 0) throw new Error("no explorer endpoint");
  return backends.length === 1 ? backends[0] : new Fallback(backends, network);
}
