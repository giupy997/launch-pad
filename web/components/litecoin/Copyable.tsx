"use client";
import { useState } from "react";
import { copyText } from "@/lib/clipboard";

/** A value people copy and paste around. The text itself selects as a
 *  block (long-press, triple-click), so it can be copied by hand when the
 *  clipboard is not available; the button says whether it really copied. */
export function Copyable({ value, label }: { value: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex items-stretch gap-2">
      <div className="min-w-0 flex-1 rounded-lg border border-white/10 px-3 py-2 font-mono text-xs text-zinc-300 break-all select-all" title="Long-press or triple-click to select">
        {label && <span className="text-zinc-600 select-none">{label} · </span>}
        {value}
      </div>
      <button
        type="button"
        onClick={async () => {
          setState((await copyText(value)) ? "copied" : "failed");
          setTimeout(() => setState("idle"), 2500);
        }}
        className={`shrink-0 rounded-lg border px-3 text-xs ${state === "failed" ? "border-white text-white" : "border-white/10 text-zinc-400 hover:border-white hover:text-white"}`}
        title="Copy"
      >
        {state === "copied" ? "copied ✓" : state === "failed" ? "not copied · select it" : "copy"}
      </button>
    </div>
  );
}
