import { formatEther, formatUnits } from "viem";

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** 0.0000000012 -> "0.0₈12" (DexScreener-style compressed zeros). */
function subscriptSmall(v: number, sig = 3): string {
  const m = v.toFixed(20).match(/^0\.(0+)([1-9]\d*)/);
  if (!m) return "0";
  const zeros = m[1].length;
  const digits = m[2].slice(0, sig).replace(/0+$/, "") || m[2][0];
  const sub = String(zeros)
    .split("")
    .map((d) => SUB[Number(d)])
    .join("");
  return `0.0${sub}${digits}`;
}

/** Human ETH amount: sensible digits per magnitude, subscript zeros when tiny. */
export function fmtEth(wei: bigint): string {
  const v = Number(formatEther(wei));
  return fmtNum(v);
}

/** Same, for assets with arbitrary decimals (quote assets). */
export function fmtUnits(amount: bigint, decimals: number): string {
  return fmtNum(Number(formatUnits(amount, decimals)));
}

/** Same formatting for plain numbers (chart axis, prices). */
export function fmtNum(v: number): string {
  if (v === 0) return "0";
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (v >= 0.001) return v.toLocaleString("en-US", { maximumFractionDigits: 5 });
  return subscriptSmall(v);
}

export function fmtTokens(wei: bigint): string {
  const v = Number(formatEther(wei));
  if (v >= 1_000_000_000) return (v / 1_000_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "B";
  if (v >= 1_000_000) return (v / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M";
  if (v >= 1_000) return (v / 1_000).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "k";
  if (v > 0 && v < 0.01) return "<0.01";
  return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** A moment as "3 days ago", "4 min ago", "just now", from unix seconds;
 *  `now` in unix seconds too (what useNow gives), the clock when left out. */
export function fmtAgo(seconds: number, now = Math.floor(Date.now() / 1000)): string {
  const d = Math.max(0, now - seconds);
  if (d < 45) return "just now";
  if (d < 3_600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86_400) return `${Math.round(d / 3_600)} h ago`;
  if (d < 30 * 86_400) return `${Math.round(d / 86_400)} days ago`.replace(/^1 days/, "1 day");
  if (d < 365 * 86_400) return `${Math.round(d / (30 * 86_400))} months ago`.replace(/^1 months/, "1 month");
  return `${Math.round(d / (365 * 86_400))} years ago`.replace(/^1 years/, "1 year");
}

/** A change as "+6.9%" or "−20%"; null (unknown) as a dash. */
export function fmtChange(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "—";
  const abs = Math.abs(pct);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 0 : 1;
  const body = abs >= 1_000 ? `${(abs / 1_000).toFixed(1)}K` : abs.toFixed(digits);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${body}%`;
}
