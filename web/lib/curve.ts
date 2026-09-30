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

/** "1%" or "1% + 3% tax" for a side of the trade. */
export function feeLabel(platformFeeBps: bigint, taxBps: number): string {
  const pct = (bps: number) => `${(bps / 100).toString().replace(/\.0+$/, "")}%`;
  const base = pct(Number(platformFeeBps));
  return taxBps > 0 ? `${base} + ${pct(taxBps)} tax` : base;
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
