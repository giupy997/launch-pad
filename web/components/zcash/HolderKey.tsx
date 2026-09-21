"use client";

import Link from "next/link";
import { useState } from "react";
import { shortKey, useHolderKey } from "@/lib/zcash/client";

/** Header chip on the Zcash pages, where a holder key stands in for a wallet. */
export function HolderChip() {
  const { ready, holder } = useHolderKey();
  if (!ready) return null;
  return (
    <Link
      href="/zcash/wallet"
      className={
        holder
          ? "rounded-full border border-zinc-700 px-3 sm:px-4 py-2 text-sm font-mono text-zinc-300 hover:border-white hover:text-white"
          : "rounded-full bg-white px-4 sm:px-5 py-2 text-sm font-semibold text-black hover:bg-zinc-200 whitespace-nowrap"
      }
    >
      {holder ? shortKey(holder) : "Make a key"}
    </Link>
  );
}

/** Inline prompt for pages that need a key before they can write a memo. */
export function NeedsHolderKey() {
  const { create, restore } = useHolderKey();
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <div className="rounded-xl border border-zinc-700 bg-black p-4 space-y-3">
      <p className="text-sm text-zinc-300">
        Shielded payments are anonymous, so coins are owned by a <b>holder key</b> made in this
        browser. It never leaves it, nobody can reset it, and whoever has it owns the balance.
      </p>
      <button
        type="button"
        onClick={create}
        className="w-full rounded-full bg-white py-2 text-sm font-semibold text-black hover:bg-zinc-200"
      >
        Make a holder key
      </button>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setBad(false);
          }}
          placeholder="…or paste a saved secret (64 hex)"
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
      {bad && <p className="text-xs text-zinc-400">⚠ Not a valid secret.</p>}
    </div>
  );
}
