import type { CurveInfo } from "@/lib/hooks";

/** The Launchpad's constants, as the contract fixes them. */
export const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
export const FEE_DENOMINATOR = 10_000n;

/** A coin's fee configuration as the pad stores it (basis points). */
export type FeeConfig = {
  buyTaxBps: number;
  sellTaxBps: number;
  creatorBps: number;
  holdersBps: number;
  burnBps: number;
  liquidityBps: number;
};

/** The fee configuration of a coin before taxes existed, or of one that set none. */
export const NO_TAX: FeeConfig = { buyTaxBps: 0, sellTaxBps: 0, creatorBps: 10_000, holdersBps: 0, burnBps: 0, liquidityBps: 0 };

/** feeConfig(token) as wagmi returns it: six uint16 in order. */
export function parseFeeConfig(result: unknown): FeeConfig {
  const r = result as readonly (number | bigint)[];
  const n = (i: number) => Number(r[i] ?? 0);
  return { buyTaxBps: n(0), sellTaxBps: n(1), creatorBps: n(2), holdersBps: n(3), burnBps: n(4), liquidityBps: n(5) };
}

/** Tokens a buy of `quoteIn` gets on the curve: the platform fee and the coin's tax off first,
 *  capped at what is left on the curve — the pad's own arithmetic. */
export function quoteBuy(curve: CurveInfo, quoteIn: bigint, platformFeeBps: bigint, fees: FeeConfig): bigint {
  if (quoteIn <= 0n) return 0n;
  const f = platformFeeBps + BigInt(fees.buyTaxBps);
  const forCurve = quoteIn - (quoteIn * f) / FEE_DENOMINATOR;
  const out = curve.vToken - (curve.vEth * curve.vToken) / (curve.vEth + forCurve);
  const remaining = CURVE_SUPPLY - curve.sold;
  return out > remaining ? remaining : out;
}

/** Quote a sell of `tokensIn` pays, after the platform fee and the coin's tax. */
export function quoteSell(curve: CurveInfo, tokensIn: bigint, platformFeeBps: bigint, fees: FeeConfig): bigint {
  if (tokensIn <= 0n) return 0n;
  let out = curve.vEth - (curve.vEth * curve.vToken) / (curve.vToken + tokensIn);
  if (out > curve.realEth) out = curve.realEth;
  const f = platformFeeBps + BigInt(fees.sellTaxBps);
  return out - (out * f) / FEE_DENOMINATOR;
}

/** The treasury's cut of a trade, in percent, as text: the platform fee less the coin's pot share of it. */
export function treasuryPct(platformFeeBps: bigint, potShareBps: bigint): string {
  const pct = (Number(platformFeeBps) * (10_000 - Number(potShareBps))) / 1_000_000;
  return `${pct.toFixed(3).replace(/\.?0+$/, "")}%`;
}

const pctText = (bps: number) => `${(bps / 100).toString().replace(/\.0+$/, "")}%`;

/** A coin's tax on one side of a trade as text: "1% buy tax", or "No buy tax". (The pad's trading fee is told elsewhere.) */
export function sideFeeLabel(taxBps: number, side: "buy" | "sell"): string {
  return taxBps > 0 ? `${pctText(taxBps)} ${side} tax` : `No ${side} tax`;
}

/** Both sides in one line: "1% buy tax · 1% sell tax"; a side without a tax is left out, and with none the line says so. */
export function feesLine(fees: { buyTaxBps: number; sellTaxBps: number }): string {
  const taxes = [fees.buyTaxBps > 0 ? `${pctText(fees.buyTaxBps)} buy tax` : null, fees.sellTaxBps > 0 ? `${pctText(fees.sellTaxBps)} sell tax` : null].filter(Boolean);
  return taxes.length ? taxes.join(" · ") : "No tax";
}

/** The non-zero shares of a coin's pot, in display order. */
export function splitParts(fees: FeeConfig): { key: keyof FeeConfig; label: string; bps: number }[] {
  const all: { key: keyof FeeConfig; label: string; bps: number }[] = [
    { key: "creatorBps", label: "creator", bps: fees.creatorBps },
    { key: "holdersBps", label: "holders", bps: fees.holdersBps },
    { key: "burnBps", label: "buyback & burn", bps: fees.burnBps },
    { key: "liquidityBps", label: "liquidity", bps: fees.liquidityBps },
  ];
  return all.filter((p) => p.bps > 0);
}
