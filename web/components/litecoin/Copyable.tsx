"use client";
import { useState } from "react";

/** A value people copy and paste around: one click copies it. */
export function Copyable({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" title="Copy"
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="block w-full rounded-lg border border-white/10 px-3 py-2 text-left font-mono text-xs text-zinc-300 break-all hover:border-white">
      {label && <span className="text-zinc-600">{label} · </span>}
      {value} <span className="text-zinc-600">{copied ? "· copied ✓" : "· copy"}</span>
    </button>
  );
}
