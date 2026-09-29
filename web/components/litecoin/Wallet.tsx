"use client";

import Link from "next/link";
import { copyText } from "@/lib/clipboard";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { LTC_NETWORK, addressLink, fmtLtc, shortAddr, useLtcWallet, useUtxos } from "@/lib/litecoin/client";

/** Header chip on the Litecoin pages: the browser wallet stands in for
 *  "connect". Open, it is a small menu: address, balance, the wallet page,
 *  funding, and forgetting the wallet on this device. */
export function LtcWalletChip() {
  const { ready, address, secret, forget } = useLtcWallet();
  const { balance } = useUtxos(address);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);
  if (!ready) return null;
  if (!address) {
    return (
      <Link href="/litecoin/wallet" className="btn-primary px-4 sm:px-5 py-2 text-sm whitespace-nowrap">
        Make a wallet
      </Link>
    );
  }
  const item = "flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900 hover:text-white";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="btn-ghost px-3 sm:px-4 py-2 text-sm font-mono whitespace-nowrap"
        title="Wallet"
      >
        <span className="hidden sm:inline">{fmtLtc(balance)} LTC · </span>
        {shortAddr(address)}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 glass rounded-2xl p-1.5 z-20 shadow-2xl shadow-black/70 fade-up">
          <div className="px-3 pt-2 pb-1">
            <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Litecoin wallet · {fmtLtc(balance)} LTC</div>
            <button
              type="button"
              onClick={async () => { setCopied((await copyText(address)) ? "ok" : "fail"); setTimeout(() => setCopied(""), 2000); }}
              className="mt-1 block w-full break-all text-left font-mono text-xs text-zinc-300 hover:text-white select-all"
              title="Copy address"
            >
              {address} <span className="text-zinc-600">{copied === "ok" ? "· copied ✓" : copied === "fail" ? "· not copied, select it" : "· copy"}</span>
            </button>
          </div>
          <Link href="/litecoin/wallet" onClick={() => setOpen(false)} className={item}>
            Wallet page <span className="text-zinc-600">claims · withdraw · secret</span>
          </Link>
          <Link href="/litecoin/fund" onClick={() => setOpen(false)} className={item}>
            Fund with ETH, BNB… <span className="text-zinc-600">swap to LTC</span>
          </Link>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              if (secret && confirmForget(secret)) forget();
            }}
            className={`${item} text-zinc-500`}
          >
            Forget on this device <span className="text-zinc-700">needs your saved secret to restore</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** Removing the wallet from this browser is only safe with its backup at
 *  hand: the person proves it by typing the start of the secret. */
export function confirmForget(secret: string): boolean {
  const typed = window.prompt(
    "Remove this wallet from this browser?\n\nThe coins stay on its address. Only the saved 64-character secret (wallet page → Reveal) brings it back; without that copy they are lost for good.\n\nTo confirm, type the first 8 characters of the secret:"
  );
  return typed !== null && typed.trim().toLowerCase() === secret.slice(0, 8);
}

/** Inline prompt for pages that need a wallet before they can send anything. */
export function NeedsLtcWallet() {
  const { create, restore } = useLtcWallet();
  // The restore field only appears on request: a landing page with a box
  // asking for a key looks like phishing, to people and to link scanners.
  const [restoring, setRestoring] = useState(false);
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <div className="card p-4 space-y-3">
      <p className="text-sm text-zinc-300">
        Every action here is a Litecoin transaction you sign yourself, so the site keeps an ordinary
        Litecoin <b>wallet</b> in this browser. It is created here, it never leaves the browser and nobody
        can reset it: whoever holds its backup owns the balance. Notus never asks for the keys of any other wallet.
      </p>
      <button
        type="button"
        onClick={create}
        className="w-full rounded-full bg-white py-2 text-sm font-semibold text-black hover:bg-zinc-100 transition-colors"
      >
        Make a wallet
      </button>
      {restoring ? (
        <div className="flex gap-2">
          <input
            value={value}
            autoFocus
            onChange={(e) => {
              setValue(e.target.value);
              setBad(false);
            }}
            placeholder="…paste the backup copied from your wallet page"
            className="flex-1 min-w-0 rounded-lg input px-3 py-1.5 text-xs font-mono outline-none focus:border-white placeholder:text-zinc-600"
          />
          <button
            type="button"
            onClick={() => setBad(!restore(value))}
            className="rounded-full border border-white/15 px-3 text-xs text-zinc-300 hover:border-white"
          >
            Restore
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setRestoring(true)} className="w-full text-center text-xs text-zinc-500 hover:text-zinc-200">
          Made one on another device? Restore it from its backup
        </button>
      )}
      {bad && <p className="text-xs text-zinc-400">⚠ That backup does not belong to a Notus wallet on this network.</p>}
    </div>
  );
}

/** Where to send LTC so the wallet can act: address, QR and live balance. */
export function FundPanel({ address, compact = false }: { address: string; compact?: boolean }) {
  const { balance, confirmed, utxos } = useUtxos(address);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(`litecoin:${address}`, { margin: 1, width: 300, color: { dark: "#000000", light: "#ffffff" } })
      .then((d) => live && setQr(d))
      .catch(() => live && setQr(""));
    return () => {
      live = false;
    };
  }, [address]);
  const pending = balance - confirmed;
  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Fund this wallet</span>
        <span className="font-mono text-sm text-white">
          {fmtLtc(balance, 8)} LTC{pending !== 0n && <span className="text-zinc-500"> · {fmtLtc(pending, 8)} pending</span>}
        </span>
      </div>
      <div className={`grid gap-4 ${compact ? "" : "sm:grid-cols-[130px_1fr]"}`}>
        {qr && !compact && (
          // eslint-disable-next-line @next/next/no-img-element -- generated data URI
          <img src={qr} alt="Address QR" className="w-[130px] h-[130px] rounded-lg" />
        )}
        <div className="space-y-2 min-w-0">
          <button
            type="button"
            onClick={async () => {
              setCopied((await copyText(address)) ? "ok" : "fail");
              setTimeout(() => setCopied(""), 2000);
            }}
            className="block w-full rounded-lg border border-white/10 px-3 py-1.5 text-left hover:border-white"
            title="Copy"
          >
            <span className="font-mono text-[9px] tracking-widest uppercase text-zinc-500">
              Address {copied === "ok" ? "· copied ✓" : copied === "fail" ? "· not copied, select it" : "· tap to copy"}
            </span>
            <span className="block break-all font-mono text-xs text-zinc-300 select-all">{address}</span>
          </button>
          <p className="text-[11px] text-zinc-600">
            Send LTC here from any wallet or exchange — a plain payment, no memo. {utxos.length} coin{utxos.length === 1 ? "" : "s"} ·{" "}
            <a href={addressLink(address)} target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
              explorer
            </a>
            {LTC_NETWORK === "test" && (
              <>
                {" "}· testnet LTC is free from a{" "}
                <a href="https://litecointf.salmen.website/" target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
                  faucet
                </a>
              </>
            )}
            .
          </p>
        </div>
      </div>
    </div>
  );
}
