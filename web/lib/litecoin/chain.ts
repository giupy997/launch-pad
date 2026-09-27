// Notus on Litecoin — which explorer(s) to read the chain through.
//
//   NOTUS_LTC_API=https://litecoinspace.org/api                       one Esplora endpoint
//   NOTUS_LTC_API=https://litecoinspace.org/api,https://litecoinblockexplorer.net/api/v2
//                                                                      …with a Blockbook one as fallback
//
// Several endpoints are tried in order: a timeout or a 5xx moves on to the
// next, a real answer (unknown transaction, rejected broadcast) does not.
// An endpoint that turns out to serve the other chain is never used: its
// genesis block says which chain it is.
import { ApiError, ChainApi, Esplora, GENESIS, TIMEOUT_MS, isFinal, type EsploraStatus, type EsploraTx, type EsploraUtxo, type Fees } from "./esplora.ts";
import { Blockbook } from "./blockbook.ts";
import type { Network } from "./ledger.ts";

/** An endpoint that just failed is left alone for this long, so a call does
 *  not wait out its timeout again and again while the next endpoint works. */
export const COOLDOWN_MS = 5 * 60_000;

/** A tip this many blocks under the best one seen is a lagging explorer, not a reorg. */
export const LAG_BLOCKS = 6;

export class Fallback extends ChainApi {
  readonly backends: ChainApi[];
  readonly network: Network;
  readonly cooldownMs: number;
  /** The endpoint that answered last. */
  lastUsed = "";
  private bestTip = 0;
  private chain = new Map<ChainApi, boolean>();
  private downUntil = new Map<ChainApi, number>();
  constructor(backends: ChainApi[], network: Network, cooldownMs = COOLDOWN_MS) {
    super();
    this.backends = backends;
    this.network = network;
    this.cooldownMs = cooldownMs;
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

  get label(): string {
    return this.backends.map((b) => b.label).join(",");
  }

  private async run<T>(f: (b: ChainApi) => Promise<T>): Promise<T> {
    const now = Date.now();
    let candidates = this.backends.filter((b) => (this.downUntil.get(b) ?? 0) <= now);
    if (candidates.length === 0) candidates = this.backends; // all cooling down: try them anyway
    let last: unknown = null;
    for (const b of candidates) {
      if (!(await this.usable(b))) continue;
      try {
        const v = await f(b);
        this.downUntil.delete(b);
        this.lastUsed = b.label;
        return v;
      } catch (e) {
        if (isFinal(e)) throw e;
        this.downUntil.set(b, Date.now() + this.cooldownMs);
        last = e;
      }
    }
    throw last ?? new ApiError("no explorer endpoint on this chain");
  }

  /** An explorer whose tip is under the best one seen is behind: it is
   *  passed over (and left alone for a while) like one that is down, so the
   *  ledger never reads a stale chain. */
  tipHeight(): Promise<number> {
    return this.run(async (b) => {
      const h = await b.tipHeight();
      if (h < this.bestTip - LAG_BLOCKS) throw new ApiError(`${b.label}: behind (tip ${h}, best seen ${this.bestTip})`, 503);
      if (h > this.bestTip) this.bestTip = h;
      return h;
    });
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
export function chainApi(spec: string, network: Network, apiKey?: string, timeoutMs = TIMEOUT_MS, cooldownMs = COOLDOWN_MS): ChainApi {
  const backends = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (isBlockbook(s) ? new Blockbook(s, network, apiKey, timeoutMs) : new Esplora(s, timeoutMs)));
  if (backends.length === 0) throw new Error("no explorer endpoint");
  return backends.length === 1 ? backends[0] : new Fallback(backends, network, cooldownMs);
}
