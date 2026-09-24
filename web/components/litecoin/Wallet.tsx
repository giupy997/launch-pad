"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { LTC_NETWORK, addressLink, fmtLtc, shortAddr, useLtcWallet, useUtxos } from "@/lib/litecoin/client";

/** Header chip on the Litecoin pages: the browser wallet stands in for "connect". */
export function LtcWalletChip() {
  const { ready, address } = useLtcWallet();
  const { balance } = useUtxos(address);
  if (!ready) return null;
  return (
    <Link
      href="/litecoin/wallet"
      className={
        address
          ? "rounded-full border border-zinc-700 px-3 sm:px-4 py-2 text-sm font-mono text-zinc-300 hover:border-white hover:text-white whitespace-nowrap"
          : "rounded-full bg-white px-4 sm:px-5 py-2 text-sm font-semibold text-black hover:bg-zinc-200 whitespace-nowrap"
      }
    >
      {address ? (
        <>
          <span className="hidden sm:inline">{fmtLtc(balance)} LTC · </span>
          {shortAddr(address)}
        </>
      ) : (
        "Make a wallet"
      )}
    </Link>
  );
}

/** Inline prompt for pages that need a wallet before they can send anything. */
export function NeedsLtcWallet() {
  const { create, restore } = useLtcWallet();
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <div className="rounded-xl border border-zinc-700 bg-black p-4 space-y-3">
      <p className="text-sm text-zinc-300">
        Every action here is a Litecoin transaction you sign yourself, so the site keeps an ordinary
        Litecoin <b>wallet</b> in this browser. Its address owns your coins. It never leaves the browser,
        nobody can reset it, and whoever has the key owns the balance.
      </p>
      <button
        type="button"
        onClick={create}
        className="w-full rounded-full bg-white py-2 text-sm font-semibold text-black hover:bg-zinc-200"
      >
        Make a wallet
      </button>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setBad(false);
          }}
          placeholder="…or paste a saved secret (64 hex) or WIF"
          className="flex-1 min-w-0 rounded-lg bg-black border border-zinc-700 px-3 py-1.5 text-xs font-mono outline-none focus:border-white placeholder:text-zinc-600"
        />
        <button
          type="button"
          onClick={() => setBad(!restore(value))}
          className="rounded-full border border-zinc-700 px-3 text-xs text-zinc-300 hover:border-white"
        >
          Restore
        </button>
      </div>
      {bad && <p className="text-xs text-zinc-400">⚠ Not a valid secret or WIF for this network.</p>}
    </div>
  );
}

/** Where to send LTC so the wallet can act: address, QR and live balance. */
export function FundPanel({ address, compact = false }: { address: string; compact?: boolean }) {
  const { balance, confirmed, utxos } = useUtxos(address);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
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
    <div className="rounded-xl border border-zinc-700 bg-black p-4">
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
            onClick={() => {
              navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="block w-full rounded-lg border border-zinc-800 px-3 py-1.5 text-left hover:border-white"
            title="Copy"
          >
            <span className="font-mono text-[9px] tracking-widest uppercase text-zinc-500">
              Address {copied ? "· copied ✓" : "· tap to copy"}
            </span>
            <span className="block break-all font-mono text-xs text-zinc-300">{address}</span>
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
