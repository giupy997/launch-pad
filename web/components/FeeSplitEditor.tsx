"use client";

/** A coin's fee configuration, as its creator sets it before launch: its own
 *  tax on buys and on sells (percent of the trade, on top of the platform
 *  fee), and how its pot is split — four shares that must total 100%. */
export type SplitPct = { creator: number; holders: number; burn: number; liquidity: number };
export const SPLIT_KEYS: (keyof SplitPct)[] = ["creator", "holders", "burn", "liquidity"];

export const SPLIT_LABELS: Record<keyof SplitPct, { title: string; hint: string }> = {
  creator: { title: "Creator funds", hint: "Accrues to you, or to the wallet you set later; claim any time" },
  holders: { title: "Dividends", hint: "Cashback for holders, pro-rata to what they hold; claim any time" },
  burn: { title: "Buyback and burn", hint: "Buys the coin back on its curve, or its pool, and burns it; anyone may press the button" },
  liquidity: { title: "Liquidity", hint: "Joins the pool's quote side the moment the coin graduates" },
};

const COLORS: Record<keyof SplitPct, string> = {
  creator: "#a78bfa",
  holders: "#f0c060",
  burn: "#f87171",
  liquidity: "#60a5fa",
};

export function splitTotal(s: SplitPct): number {
  return s.creator + s.holders + s.burn + s.liquidity;
}

export function FeeSplitEditor({
  buyTax,
  sellTax,
  maxTax,
  split,
  onTax,
  onSplit,
}: {
  buyTax: number;
  sellTax: number;
  maxTax: number;
  split: SplitPct;
  onTax: (side: "buy" | "sell", pct: number) => void;
  onSplit: (s: SplitPct) => void;
}) {
  const total = splitTotal(split);
  const clampPct = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v * 2) / 2));

  function setShare(key: keyof SplitPct, value: number) {
    const others = total - split[key];
    const max = 100 - others;
    onSplit({ ...split, [key]: Math.max(0, Math.min(max, Math.round(value))) });
  }

  // the ring: each share an arc, the part not yet given away in grey
  const arcs = SPLIT_KEYS.filter((k) => split[k] > 0).reduce<{ stops: string[]; acc: number }>(
    (r, k) => ({ stops: [...r.stops, `${COLORS[k]} ${r.acc}% ${r.acc + split[k]}%`], acc: r.acc + split[k] }),
    { stops: [], acc: 0 },
  );
  const stops = arcs.acc < 100 ? [...arcs.stops, `#27272a ${arcs.acc}% 100%`] : arcs.stops;
  const ring = `conic-gradient(${stops.join(", ")})`;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(["buy", "sell"] as const).map((side) => {
          const v = side === "buy" ? buyTax : sellTax;
          return (
            <div key={side}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-zinc-300">{side === "buy" ? "Buy tax" : "Sell tax"}</span>
                <span className="font-mono text-[10px] text-zinc-600">max {maxTax}%</span>
              </div>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  aria-label={side === "buy" ? "Buy tax, percent" : "Sell tax, percent"}
                  min={0}
                  max={maxTax}
                  step={0.5}
                  value={v}
                  onChange={(e) => onTax(side, clampPct(parseFloat(e.target.value), maxTax))}
                  className="flex-1 accent-white"
                />
                <label className="flex items-center gap-1 rounded-full input px-3 py-1 font-mono text-xs">
                  <input
                    type="number"
                    min={0}
                    max={maxTax}
                    step={0.5}
                    value={v}
                    onChange={(e) => onTax(side, clampPct(parseFloat(e.target.value) || 0, maxTax))}
                    className="w-10 bg-transparent text-right outline-none"
                  />
                  <span className="text-zinc-500">%</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-zinc-500">
        Each share stops where the others leave off. They must total 100% to launch — of the 0.8% pot the platform fee leaves
        and of your whole tax.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-6 items-center">
        <div className="space-y-4">
          {SPLIT_KEYS.map((key) => {
            const max = 100 - (total - split[key]);
            return (
              <div key={key}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-zinc-300 flex items-center gap-2">
                    <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: COLORS[key] }} />
                    {SPLIT_LABELS[key].title}
                    <span className="text-zinc-600 text-[11px]" title={SPLIT_LABELS[key].hint}>
                      ⓘ
                    </span>
                  </span>
                  <span className="font-mono text-[10px] text-zinc-600">max {max}%</span>
                </div>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    aria-label={`${SPLIT_LABELS[key].title} share, percent`}
                    min={0}
                    max={max}
                    step={1}
                    value={split[key]}
                    onChange={(e) => setShare(key, parseInt(e.target.value, 10))}
                    className="flex-1"
                    style={{ accentColor: COLORS[key] }}
                  />
                  <label className="flex items-center gap-1 rounded-full input px-3 py-1 font-mono text-xs">
                    <input
                      type="number"
                      min={0}
                      max={max}
                      step={1}
                      value={split[key]}
                      onChange={(e) => setShare(key, parseInt(e.target.value, 10) || 0)}
                      className="w-10 bg-transparent text-right outline-none"
                    />
                    <span className="text-zinc-500">%</span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>
        <div className="mx-auto">
          <div className="relative w-40 h-40 rounded-full" style={{ background: ring }} role="img" aria-label={`${total}% of the split given`}>
            <div className="absolute inset-4 rounded-full bg-black flex flex-col items-center justify-center">
              <span className={`font-mono text-2xl font-bold ${total === 100 ? "text-white" : "text-zinc-400"}`}>{total}%</span>
              <span className="text-[10px] text-zinc-500">Total split</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
