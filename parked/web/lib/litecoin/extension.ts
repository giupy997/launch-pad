"use client";

// Notus on Litecoin — extension wallets. Two browser extensions speak the
// UniSat-shaped API for Litecoin: Litescribe (litescribe.io, a Litecoin fork
// of UniSat Wallet, `window.litescribe`) and Enkrypt (enkrypt.com, by the
// MyEtherWallet team, whose Bitcoin-family provider also carries Litecoin,
// `window.enkrypt.providers.bitcoin`). Either gives accounts on request,
// signs a PSBT on the person's approval and signs text the Litecoin way.
// The site hands them the transactions it builds and never sees a key.
import { useSyncExternalStore } from "react";
import type { Network } from "./ledger.ts";

export type SignInput = { index: number; address: string };

export type LtcProvider = {
  requestAccounts(): Promise<string[]>;
  getAccounts(): Promise<string[]>;
  getNetwork(): Promise<string>;
  switchNetwork(network: string): Promise<unknown>;
  getPublicKey(): Promise<string>;
  signPsbt(psbtHex: string, options?: { autoFinalized?: boolean; toSignInputs?: SignInput[] }): Promise<string>;
  signMessage(text: string, type?: "ecdsa" | "bip322-simple"): Promise<string>;
  on?(event: string, handler: (data: unknown) => void): void;
  removeListener?(event: string, handler: (data: unknown) => void): void;
};

declare global {
  interface Window {
    litescribe?: LtcProvider;
    enkrypt?: { providers?: { bitcoin?: LtcProvider } };
  }
}

export type ExtensionId = "litescribe" | "enkrypt";

export type Extension = {
  id: ExtensionId;
  name: string;
  url: string;
  /** The provider the extension injected, when it is installed. */
  get(): LtcProvider | null;
  /** The extension's own name for one of this site's networks; null when it has no such network. */
  networkName(n: Network): string | null;
};

/** Fired on `window` once Litescribe has injected itself; Enkrypt is there before the page runs. */
export const READY_EVENT = "litescribe#initialized";

export const EXTENSIONS: readonly Extension[] = [
  {
    id: "litescribe",
    name: "Litescribe",
    url: "https://litescribe.io/",
    get: () => (typeof window === "undefined" ? null : (window.litescribe ?? null)),
    networkName: (n) => (n === "main" ? "livenet" : "testnet"),
  },
  {
    id: "enkrypt",
    name: "Enkrypt",
    url: "https://www.enkrypt.com/",
    get: () => (typeof window === "undefined" ? null : (window.enkrypt?.providers?.bitcoin ?? null)),
    // Enkrypt carries Litecoin mainnet only
    networkName: (n) => (n === "main" ? "litecoin" : null),
  },
];

export const extensionById = (id: string | null | undefined): Extension | undefined => EXTENSIONS.find((e) => e.id === id);

/** The extensions this browser has, that know this site's network. */
export function installedExtensions(network: Network): Extension[] {
  return EXTENSIONS.filter((e) => e.get() !== null && e.networkName(network) !== null);
}

export type ExtWallet = { extension: ExtensionId; address: string; pubkey: string; network: string };

/** Wait, briefly, for an extension that injects itself a moment after the page loads. */
function whenInjected(ext: Extension, ms: number): Promise<LtcProvider | null> {
  const p = ext.get();
  if (p || typeof window === "undefined") return Promise.resolve(p);
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener(READY_EVENT, done);
      clearInterval(poll);
      clearTimeout(t);
      resolve(ext.get());
    };
    const poll = setInterval(() => ext.get() && done(), 100);
    const t = setTimeout(done, ms);
    window.addEventListener(READY_EVENT, done);
  });
}

/** One connection per site network, remembered across reloads: once a site
 *  is allowed, an extension answers without asking again. */
export function createExtensionStore(network: Network) {
  const FLAG = `notus.litecoin.ext.${network}`;
  let wallet: ExtWallet | null = null;
  let resolved = false; // a remembered connection was looked up (or there was none)
  let started = false;
  const listening = new Set<ExtensionId>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const set = (w: ExtWallet | null) => {
    wallet = w;
    emit();
  };

  /** The connected account, or null when the extension has not allowed this site (no prompt). */
  async function read(ext: Extension, p: LtcProvider): Promise<ExtWallet | null> {
    const net = await p.getNetwork();
    if (!net) return null; // Enkrypt: not allowed here yet (asking would open a prompt)
    const [address] = await p.getAccounts();
    if (!address) return null;
    const pubkey = await p.getPublicKey();
    return { extension: ext.id, address, pubkey, network: net };
  }

  /** Follow the extension: another account or network chosen inside it shows here. */
  function listen(ext: Extension, p: LtcProvider) {
    if (listening.has(ext.id) || !p.on) return;
    listening.add(ext.id);
    const refresh = () => {
      if (wallet?.extension !== ext.id) return;
      read(ext, p).then(set).catch(() => set(null));
    };
    p.on("accountsChanged", refresh);
    p.on("networkChanged", refresh);
  }

  function restore() {
    if (started) return;
    started = true;
    let ext: Extension | undefined;
    try {
      ext = extensionById(localStorage.getItem(FLAG));
    } catch {}
    if (!ext) {
      resolved = true;
      emit();
      return;
    }
    whenInjected(ext, 1500)
      .then(async (p) => {
        if (!p) return;
        set(await read(ext!, p));
        listen(ext!, p);
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

  function current(): { ext: Extension; p: LtcProvider } {
    const ext = extensionById(wallet?.extension);
    const p = ext?.get();
    if (!ext || !p) throw new Error(`${ext?.name ?? "the extension"} is not available: reload the page`);
    return { ext, p };
  }

  return {
    /** The connected wallet, and whether a remembered one has been looked up yet. */
    useWallet(): { ext: ExtWallet | null; resolved: boolean } {
      const ext = useSyncExternalStore(subscribe, () => wallet, () => null);
      const ok = useSyncExternalStore(subscribe, () => resolved, () => false);
      return { ext, resolved: ok };
    },
    async connect(id: ExtensionId): Promise<ExtWallet> {
      const ext = extensionById(id);
      const p = ext?.get();
      if (!ext || !p) throw new Error(`${ext?.name ?? id} is not installed in this browser`);
      const [address] = await p.requestAccounts();
      if (!address) throw new Error(`${ext.name} gave no account`);
      const [pubkey, net] = await Promise.all([p.getPublicKey(), p.getNetwork()]);
      try {
        localStorage.setItem(FLAG, ext.id);
      } catch {}
      listen(ext, p);
      const w: ExtWallet = { extension: ext.id, address, pubkey, network: net };
      set(w);
      return w;
    },
    disconnect() {
      try {
        localStorage.removeItem(FLAG);
      } catch {}
      set(null);
    },
    /** Ask the connected extension to move to this site's network, then read it again. */
    async switchNetwork(): Promise<void> {
      const { ext, p } = current();
      const name = ext.networkName(network);
      if (!name) throw new Error(`${ext.name} has no Litecoin ${network === "main" ? "mainnet" : "testnet"}`);
      await p.switchNetwork(name);
      set(await read(ext, p));
    },
    /** Hand the connected extension a PSBT to sign and finalize; it answers with the signed PSBT (hex). */
    async signPsbt(psbtHex: string, toSign: SignInput[]): Promise<string> {
      const { p } = current();
      return p.signPsbt(psbtHex, { autoFinalized: true, toSignInputs: toSign });
    },
    /** Text signed the Litecoin way (ECDSA, recoverable, base64) by the connected account. */
    async signText(text: string): Promise<string> {
      const { p } = current();
      return p.signMessage(text, "ecdsa");
    },
  };
}
