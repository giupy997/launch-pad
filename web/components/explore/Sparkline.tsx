/** A price line in a small box: the shape of the day, nothing more. */
export function Sparkline({ points, className = "h-20 w-full" }: { points: number[]; className?: string }) {
  if (points.length < 2) {
    return <div className={`${className} rounded-lg border border-dashed border-white/10`} aria-hidden />;
  }
  const w = 400;
  const h = 100;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || max || 1;
  const xs = points.map((p, i) => [(i / (points.length - 1)) * w, h - 6 - ((p - min) / span) * (h - 12)] as const);
  const d = xs.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={className} aria-hidden>
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity={up ? 0.18 : 0.1} />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="url(#spark-fill)" />
      <path d={d} fill="none" stroke="white" strokeOpacity={up ? 0.95 : 0.6} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
