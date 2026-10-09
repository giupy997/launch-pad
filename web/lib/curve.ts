import type { CurveInfo } from "@/lib/hooks";

/** The Launchpad's constants, as the contract fixes them. */
export const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
export const FEE_DENOMINATOR = 10_000n;

/** A coin's fee configuration as the pad stores it (basis points): its own
 *  tax each way and the split of that tax, plus the launchpad's rate the coin
 *  trades at. On v12 the rate is stamped on the coin at creation (the seventh
 *  field, whole to the treasury, on the curve and on the pool); on v11 it is
 *  the pad's feeBps(), carried here so the two read alike. */
export type FeeConfig = {
  buyTaxBps: number;
  sellTaxBps: number;
  creatorBps: number;
  holdersBps: number;
  burnBps: number;
  liquidityBps: number;
  platformBps: number;
};

/** The fee configuration of a coin before taxes existed, or of one that set none. */
export const NO_TAX: FeeConfig = { buyTaxBps: 0, sellTaxBps: 0, creatorBps: 10_000, holdersBps: 0, burnBps: 0, liquidityBps: 0, platformBps: 0 };

/** feeConfig(token) as wagmi returns it: six uint16 in order on v11, seven on
 *  v12. A six-field answer takes `fallbackPlatformBps`, the pad's feeBps()
 *  (its meaning differs there: the treasury got a share of it, see
 *  treasuryPctV11, but it is the rate the coin trades at either way). */
export function parseFeeConfig(result: unknown, fallbackPlatformBps: number): FeeConfig {
  const r = result as readonly (number | bigint)[];
  const n = (i: number) => Number(r[i] ?? 0);
  return {
    buyTaxBps: n(0),
    sellTaxBps: n(1),
    creatorBps: n(2),
    holdersBps: n(3),
    burnBps: n(4),
    liquidityBps: n(5),
    platformBps: r.length >= 7 ? n(6) : fallbackPlatformBps,
  };
}

/** What a coin's pool charges on one side of a trade, in basis points: the
 *  launchpad's rate and the coin's tax for that side, taken in coins by the
 *  token on every transfer out of (a buy) or into (a sell) a registered pool. */
export function poolRate(fees: FeeConfig, side: "buy" | "sell"): number {
  return fees.platformBps + (side === "buy" ? fees.buyTaxBps : fees.sellTaxBps);
}

/** `amount` less a rate in basis points: what a pool trade delivers after the
 *  token's charge, the pad's own rounding. */
export function netOfRate(amount: bigint, rateBps: number): bigint {
  return amount - (amount * BigInt(rateBps)) / FEE_DENOMINATOR;
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

const trimPct = (pct: number) => `${pct.toFixed(3).replace(/\.?0+$/, "")}%`;

/** The treasury's cut of a trade, in percent, as text: on v12 the whole of the
 *  launchpad's rate the coin was stamped with (FeeConfig.platformBps). */
export function treasuryPct(platformBps: number | bigint): string {
  return trimPct(Number(platformBps) / 100);
}

/** The same on a v11 pad, where the platform fee fed the coin's pot too: the
 *  fee less the pot's share of it (creatorFeeShareBps + holderCashbackBps). */
export function treasuryPctV11(platformFeeBps: bigint, potShareBps: bigint): string {
  return trimPct((Number(platformFeeBps) * (10_000 - Number(potShareBps))) / 1_000_000);
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
