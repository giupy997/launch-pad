"use client";

// Notus on Litecoin — an extension wallet. Litescribe (litescribe.io), a
// Litecoin fork of UniSat Wallet, injects `window.litescribe` into pages:
// accounts on request, a PSBT signed on the person's approval, text signed
// the Litecoin way. The site hands it the transactions it builds and never
// sees a key. Any wallet speaking the same API could stand in the same way.
import { useSyncExternalStore } from "react";
import type { Network } from "./ledger.ts";

export const EXTENSION_NAME = "Litescribe";
export const EXTENSION_URL = "https://litescribe.io/";
/** Fired on `window` once the extension has injected itself. */
export const READY_EVENT = "litescribe#initialized";

export type SignInput = { index: number; address: string };

export type LtcProvider = {
  requestAccounts(): Promise<string[]>;
  getAccounts(): Promise<string[]>;
  getNetwork(): Promise<string>;
  switchNetwork(network: string): Promise<string>;
  getPublicKey(): Promise<string>;
  signPsbt(psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: SignInput[] }): Promise<string>;
  signMessage(text: string, type?: "ecdsa" | "bip322-simple"): Promise<string>;
  on?(event: string, handler: (data: unknown) => void): void;
  removeListener?(event: string, handler: (data: unknown) => void): void;
};

declare global {
  interface Window {
    litescribe?: LtcProvider;
  }
}

/** The extension's name for each of this site's networks. */
export const providerNetwork = (n: Network) => (n === "main" ? "livenet" : "testnet");

export type ExtWallet = { address: string; pubkey: string; network: string };

export function provider(): LtcProvider | null {
  return typeof window === "undefined" ? null : (window.litescribe ?? null);
}

export const hasExtension = () => provider() !== null;

/** The extension injects itself a moment after the page loads: wait for it, briefly. */
function whenInjected(ms: number): Promise<LtcProvider | null> {
  const p = provider();
  if (p || typeof window === "undefined") return Promise.resolve(p);
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener(READY_EVENT, done);
      clearTimeout(t);
      resolve(provider());
    };
    const t = setTimeout(done, ms);
    window.addEventListener(READY_EVENT, done);
  });
}

/** One connection per site network, remembered across reloads: once a site
 *  is allowed, the extension answers getAccounts without asking again. */
export function createExtensionStore(network: Network) {
  const FLAG = `notus.litecoin.ext.${network}`;
  let wallet: ExtWallet | null = null;
  let resolved = false; // a remembered connection was looked up (or there was none)
  let started = false;
  let listening = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const set = (w: ExtWallet | null) => {
    wallet = w;
    emit();
  };

  async function read(p: LtcProvider): Promise<ExtWallet | null> {
    const [address] = await p.getAccounts();
    if (!address) return null;
    const [pubkey, net] = await Promise.all([p.getPublicKey(), p.getNetwork()]);
    return { address, pubkey, network: net };
  }

  /** Follow the extension: another account or network chosen inside it shows here. */
  function listen(p: LtcProvider) {
    if (listening || !p.on) return;
    listening = true;
    const refresh = () => read(p).then(set).catch(() => set(null));
    p.on("accountsChanged", refresh);
    p.on("networkChanged", refresh);
  }

  function restore() {
    if (started) return;
    started = true;
    let flagged = false;
    try {
      flagged = !!localStorage.getItem(FLAG);
    } catch {}
    if (!flagged) {
      resolved = true;
      emit();
      return;
    }
    whenInjected(1500)
      .then(async (p) => {
        if (!p) return;
        set(await read(p));
        listen(p);
      })
      .catch(() => set(null))
      .finally(() => {
        resolved = true;
        emit();
      });
  }

  function subscribe(l: () => void) {
    listeners.add(l);
    restore();
    return () => {
      listeners.delete(l);
    };
  }

  return {
    /** The connected wallet, and whether a remembered one has been looked up yet. */
    useWallet(): { ext: ExtWallet | null; resolved: boolean } {
      const ext = useSyncExternalStore(subscribe, () => wallet, () => null);
      const ok = useSyncExternalStore(subscribe, () => resolved, () => false);
      return { ext, resolved: ok };
    },
    async connect(): Promise<ExtWallet> {
      const p = provider();
      if (!p) throw new Error(`${EXTENSION_NAME} is not installed in this browser`);
      const [address] = await p.requestAccounts();
      if (!address) throw new Error(`${EXTENSION_NAME} gave no account`);
      const [pubkey, net] = await Promise.all([p.getPublicKey(), p.getNetwork()]);
      try {
        localStorage.setItem(FLAG, "1");
      } catch {}
      listen(p);
      const w = { address, pubkey, network: net };
      set(w);
      return w;
    },
    disconnect() {
      try {
        localStorage.removeItem(FLAG);
      } catch {}
      set(null);
    },
    /** Ask the extension to move to this site's network, then read it again. */
    async switchNetwork(): Promise<void> {
      const p = provider();
      if (!p) return;
      await p.switchNetwork(providerNetwork(network));
      set(await read(p));
    },
  };
}

/** Hand the extension a PSBT to sign and finalize; it answers with the signed PSBT (hex). */
export async function signPsbtWithExtension(psbtHex: string, toSign: SignInput[]): Promise<string> {
  const p = provider();
  if (!p) throw new Error(`${EXTENSION_NAME} is not available: reload the page`);
  return p.signPsbt(psbtHex, { autoFinalized: true, toSignInputs: toSign });
}

/** Text signed the Litecoin way (ECDSA, recoverable, base64) by the connected account. */
export async function signTextWithExtension(text: string): Promise<string> {
  const p = provider();
  if (!p) throw new Error(`${EXTENSION_NAME} is not available: reload the page`);
  return p.signMessage(text, "ecdsa");
}
