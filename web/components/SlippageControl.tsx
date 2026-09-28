"use client";

import { useEffect, useState } from "react";

const KEY = "notus.slippageBps";
const PRESETS = [50, 100, 300]; // 0.5% · 1% · 3%

export function useSlippageBps(): [number, (bps: number) => void] {
  const [bps, setBps] = useState(100);
  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY));
    if (saved >= 10 && saved <= 5000) setBps(saved);
  }, []);
  const update = (v: number) => {
    const clamped = Math.max(10, Math.min(5000, Math.round(v)));
    setBps(clamped);
    localStorage.setItem(KEY, String(clamped));
  };
  return [bps, update];
}

/** Compact slippage selector: presets plus a free % input (0.1–50%). */
export function SlippageControl({
  bps,
  onChange,
}: {
  bps: number;
  onChange: (bps: number) => void;
}) {
  const isPreset = PRESETS.includes(bps);
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mr-1">
        Slippage
      </span>
      {PRESETS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={`rounded-full px-2.5 py-1 text-xs font-mono ${
            bps === p
              ? "bg-white text-black"
              : "border border-white/15 text-zinc-400 hover:border-white hover:text-white"
          }`}
        >
          {p / 100}%
        </button>
      ))}
      <div
        className={`flex items-center rounded-full border px-2 py-1 ${
          !isPreset ? "border-white text-white" : "border-white/15 text-zinc-400"
        }`}
      >
        <input
          type="number"
          step="0.1"
          min="0.1"
          max="50"
          value={!isPreset ? bps / 100 : ""}
          placeholder="…"
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(v * 100);
          }}
          className="w-10 bg-transparent text-xs font-mono outline-none text-right"
        />
        <span className="text-xs font-mono ml-0.5">%</span>
      </div>
    </div>
  );
}
