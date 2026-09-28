"use client";

import { fmtNum } from "@/lib/format";
import { useNativeSymbol } from "@/lib/hooks";

/** Minimal monochrome SVG line chart of trade-implied prices. */
export function PriceChart({
  points,
  quoteSymbol: quoteSymbolProp,
  label = "Price",
  format,
}: {
  points: number[];
  quoteSymbol?: string;
  /** What the points are ("Price", "Market cap"). */
  label?: string;
  /** How to print one; default: the number and the quote symbol. */
  format?: (v: number) => string;
}) {
  const native = useNativeSymbol();
  const quoteSymbol = quoteSymbolProp ?? native;
  const show = format ?? ((v: number) => `${fmt(v)} ${quoteSymbol}`);
  if (points.length < 2) {
    return (
      <div className="rounded-xl border border-white/10 p-6 text-center text-sm text-zinc-600">
        Price chart appears after a couple of trades.
      </div>
    );
  }

  const W = 640;
  const H = 160;
  const PAD = 8;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || max || 1;

  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (points.length - 1);
  const y = (v: number) => H - PAD - ((v - min) * (H - PAD * 2)) / span;
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const up = last >= points[0];

  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
          {label} · last {points.length} trades
        </span>
        <span className="font-mono text-xs text-zinc-300">
          {show(last)} {up ? "↗" : "↘"}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
        <path d={`${d} L${x(points.length - 1)},${H - PAD} L${x(0)},${H - PAD} Z`} fill="white" opacity="0.06" />
        <path d={d} fill="none" stroke="white" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between font-mono text-[10px] text-zinc-600 mt-1">
        <span>min {show(min)}</span>
        <span>max {show(max)}</span>
      </div>
    </div>
  );
}

const fmt = fmtNum;
