"use client";
import { useEffect, useState } from "react";
import { processLogoFile, dataUriBytes } from "@/lib/image";

/** Upload a coin logo: squared and compressed in the browser, pinned to IPFS
 *  by the site, handed back as the ipfs:// URI the logo instruction carries.
 *  Renders nothing when the site has no pinning key. */
export function LogoUpload({ name, onUploaded }: { name: string; onUploaded: (uri: string) => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"" | "processing" | "pinning">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/ltc-logo", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { enabled?: boolean }) => alive && setEnabled(!!j.enabled))
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
      setBusy("pinning");
      const r = await fetch("/api/ltc-logo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataUri, name }) });
      const j = (await r.json()) as { uri?: string; error?: string };
      if (!r.ok || !j.uri) throw new Error(j.error ?? `upload failed (HTTP ${r.status})`);
      setDone(`${(dataUriBytes(dataUri) / 1024).toFixed(1)} KB pinned · ${j.uri}`);
      onUploaded(j.uri);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not upload the image");
    } finally {
      setBusy("");
    }
  }

  if (!enabled) return null;
  return (
    <div className="space-y-1">
      <label className="block cursor-pointer rounded-lg border border-dashed border-zinc-700 px-3 py-3 text-center text-sm text-zinc-400 hover:border-white hover:text-white">
        {busy === "processing" ? "Squaring and compressing…" : busy === "pinning" ? "Pinning to IPFS…" : done ? "Logo ready · tap to change" : "📷 Upload a square image (pinned to IPFS)"}
        <input type="file" accept="image/*" className="hidden" disabled={!!busy} onChange={(e) => onFile(e.target.files?.[0])} />
      </label>
      {done && <p className="break-all font-mono text-[11px] text-zinc-500">{done}</p>}
      {error && <p className="text-[11px] text-zinc-500">⚠ {error}</p>}
    </div>
  );
}
