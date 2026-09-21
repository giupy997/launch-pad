"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { fmtZec, paymentUri } from "@/lib/zcash/client";

/** Zcash has no "connect wallet": every action is a shielded payment to the
 *  desk carrying a memo. This shows exactly what to send, three ways — a
 *  wallet link, a QR for a phone wallet, and the raw fields to paste. */
export function PaymentPanel({
  address,
  zat,
  memo,
  title,
  note,
}: {
  address: string;
  zat: bigint;
  memo: string;
  title: string;
  note?: string;
}) {
  const uri = paymentUri(address, zat, memo);
  const [qr, setQr] = useState("");
  const tooLong = new TextEncoder().encode(memo).length > 512;

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(uri, { margin: 1, width: 360, color: { dark: "#000000", light: "#ffffff" } })
      .then((d) => live && setQr(d))
      .catch(() => live && setQr(""));
    return () => {
      live = false;
    };
  }, [uri]);

  if (tooLong) return <p className="text-sm text-zinc-400">⚠ Memo over 512 bytes — shorten the name or logo URL.</p>;

  return (
    <div className="rounded-xl border border-zinc-700 bg-black p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{title}</span>
        <span className="font-mono text-sm text-white">{fmtZec(zat, 8)} ZEC</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-[150px_1fr]">
        {qr && (
          // eslint-disable-next-line @next/next/no-img-element -- generated data URI
          <img src={qr} alt="Payment QR" className="w-[150px] h-[150px] rounded-lg" />
        )}
        <div className="space-y-2 min-w-0">
          <a
            href={uri}
            className="block rounded-full bg-white py-2 text-center text-sm font-semibold text-black hover:bg-zinc-200"
          >
            Open in wallet
          </a>
          <Field label="To (shielded)" value={address} />
          <Field label="Amount" value={(Number(zat) / 1e8).toFixed(8).replace(/\.?0+$/, "")} />
          <Field label="Memo" value={memo} />
        </div>
      </div>
      <p className="text-[11px] text-zinc-600">
        {note ?? "Send exactly this from any shielded Zcash wallet."} It is folded into the ledger after 2
        confirmations (~3 min). A memo typed wrong does nothing — paste it, do not retype it.
      </p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="block w-full rounded-lg border border-zinc-800 px-3 py-1.5 text-left hover:border-white"
      title="Copy"
    >
      <span className="font-mono text-[9px] tracking-widest uppercase text-zinc-500">
        {label} {copied ? "· copied ✓" : "· tap to copy"}
      </span>
      <span className="block truncate font-mono text-xs text-zinc-300">{value}</span>
    </button>
  );
}
