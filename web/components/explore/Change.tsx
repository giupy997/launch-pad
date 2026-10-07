import { fmtChange } from "@/lib/format";

/** A day's change: lit when up, dimmed when down, a dash when unknown. */
export function Change({ pct, className = "" }: { pct: number | null; className?: string }) {
  const tone = pct === null ? "text-zinc-600" : pct > 0 ? "text-white" : pct < 0 ? "text-zinc-400" : "text-zinc-500";
  return (
    <span className={`font-mono tabular-nums ${tone} ${className}`}>
      {fmtChange(pct)}
      {pct !== null && <span className="ml-1 text-[10px] uppercase tracking-widest text-zinc-600">24h</span>}
    </span>
  );
}
