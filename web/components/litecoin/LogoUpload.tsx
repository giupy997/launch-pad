"use client";
import { useEffect, useState } from "react";
import { processLogoFile, dataUriBytes } from "@/lib/image";
import { decodeDataUri } from "@/lib/litecoin/pin";
import { signLogo } from "@/lib/litecoin/logoAuth";
import { useLtcWallet } from "@/lib/litecoin/client";

/** Upload a coin logo: squared and compressed in the browser, signed with
 *  the wallet key (the site keeps pictures only for wallets that hold LTC),
 *  kept by the site (on IPFS, or in its own store), handed back as the short
 *  URL the logo instruction carries. Renders nothing when the site cannot
 *  keep it, or without a wallet. */
export function LogoUpload({ name, onUploaded }: { name: string; onUploaded: (uri: string) => void }) {
  const { secret } = useLtcWallet();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [via, setVia] = useState<string | null>(null);
  const [busy, setBusy] = useState<"" | "processing" | "pinning">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/ltc-logo", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { enabled?: boolean; via?: string | null }) => {
        if (!alive) return;
        setEnabled(!!j.enabled);
        setVia(j.via ?? null);
      })
      .catch(() => alive && setEnabled(false));
    return () => {
      alive = false;
    };
  }, []);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError("");
    setDone("");
    try {
      setBusy("processing");
      const dataUri = await processLogoFile(file);
      if (!secret) throw new Error("make a wallet first: uploads are signed with it");
      const auth = signLogo(secret, decodeDataUri(dataUri).bytes);
      setBusy("pinning");
      const r = await fetch("/api/ltc-logo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataUri, name, auth }) });
      const j = (await r.json()) as { uri?: string; error?: string };
      if (!r.ok || !j.uri) throw new Error(j.error ?? `upload failed (HTTP ${r.status})`);
      setDone(`${(dataUriBytes(dataUri) / 1024).toFixed(1)} KB · ${j.uri}`);
      onUploaded(j.uri);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not upload the image");
    } finally {
      setBusy("");
    }
  }

  if (!enabled || !secret) return null;
  return (
    <div className="space-y-1">
      <label className="block cursor-pointer rounded-lg border border-dashed border-white/15 px-3 py-3 text-center text-sm text-zinc-400 hover:border-white hover:text-white">
        {busy === "processing"
          ? "Squaring and compressing…"
          : busy === "pinning"
            ? "Uploading…"
            : done
              ? "Logo ready · tap to change"
              : `📷 Upload a square image${via === "ipfs" ? " (pinned to IPFS)" : ""}`}
        <input type="file" accept="image/*" className="hidden" disabled={!!busy} onChange={(e) => onFile(e.target.files?.[0])} />
      </label>
      {done && <p className="break-all font-mono text-[11px] text-zinc-500">{done}</p>}
      {error && <p className="text-[11px] text-zinc-500">⚠ {error}</p>}
    </div>
  );
}
