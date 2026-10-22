import { encodeFunctionData, encodePacked, erc20Abi, getContractAddress } from "viem";
import { launchpadAbi, zapRouterAbi } from "./abi.ts";

// Launching a coin with its dev buy in one go. The pad's createTokenWithFees
// takes a dev buy only as native value, so on a cbLTC curve the buy is a
// call of its own; a wallet that batches calls (EIP-5792, atomic) sends the
// launch and the buy as one transaction, and nobody gets in between. The
// coin's address is known before it exists: the factory deploys with a plain
// CREATE, so it is the factory's address and nonce. Were another coin created
// first, that address would be somebody else's coin: a setFeeRecipient on it,
// which only the creator may call, sits between the launch and the buy and
// reverts the whole batch in that case. Pure: no React, no wagmi, node-tested.

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
/** the fresh curve's token side (LaunchpadBase.VIRTUAL_TOKEN) */
export const VIRTUAL_TOKEN = 1_050_000_000n * 10n ** 18n;
/** what a curve sells before it graduates (LaunchpadBase.CURVE_SUPPLY) */
export const CURVE_SUPPLY = 800_000_000n * 10n ** 18n;
/** the slippage a dev buy takes on its minimums: the curve is fresh, only the ETH leg moves */
export const DEV_BUY_SLIPPAGE_BPS = 100n;

export type Call = { to: `0x${string}`; data: `0x${string}`; value?: bigint };

export type FeeConfig7 = {
  buyTaxBps: number;
  sellTaxBps: number;
  creatorBps: number;
  holdersBps: number;
  burnBps: number;
  liquidityBps: number;
  platformBps: number;
};

export type TokenMetadata = {
  logoURI: string;
  website: string;
  twitter: string;
  telegram: string;
  livestream: string;
  description: string;
};

export type DevBuy =
  /** paid in the curve's own quote (cbLTC), pulled from the creator; `approve` when the pad's allowance is short */
  | { kind: "quote"; quote: `0x${string}`; amount: bigint; minTokensOut: bigint; approve: boolean }
  /** paid in ETH through the zap router: the DEX leg along `path`, then the curve */
  | { kind: "eth"; zap: `0x${string}`; path: `0x${string}`; value: bigint; minQuoteOut: bigint; minTokensOut: bigint };

export type Launch = {
  pad: `0x${string}`;
  /** the coin's address as the factory will give it (predictedToken) */
  token: `0x${string}`;
  name: string;
  symbol: string;
  meta: TokenMetadata;
  quoteAsset: `0x${string}`;
  fees: FeeConfig7;
  devBuy: DevBuy | null;
};

/** The address the pad's factory gives the coin it deploys next: a CREATE from the
 *  factory at its current nonce (eth_getTransactionCount of the factory). */
export function predictedToken(factory: `0x${string}`, nonce: number | bigint): `0x${string}` {
  return getContractAddress({ from: factory, nonce: BigInt(nonce) });
}

/** Tokens a buy of `quoteIn` gets on a curve that has just opened with `virtualReserve`
 *  of quote, at `rateBps` of fee (the launchpad's and the coin's buy tax together): the
 *  pad's own arithmetic, capped at the curve's supply. */
export function freshCurveBuy(virtualReserve: bigint, quoteIn: bigint, rateBps: bigint): bigint {
  if (quoteIn <= 0n || virtualReserve <= 0n) return 0n;
  const forCurve = quoteIn - (quoteIn * rateBps) / 10_000n;
  const out = VIRTUAL_TOKEN - (virtualReserve * VIRTUAL_TOKEN) / (virtualReserve + forCurve);
  return out > CURVE_SUPPLY ? CURVE_SUPPLY : out;
}

/** `amount` less the dev buy's slippage: the minimum a call accepts */
export function lessSlippage(amount: bigint, bps: bigint = DEV_BUY_SLIPPAGE_BPS): bigint {
  return amount - (amount * bps) / 10_000n;
}

/** A one-hop zap path from WETH to the quote through the pool with this fee or tick spacing. */
export function zapPath(weth: `0x${string}`, hop: number, quote: `0x${string}`): `0x${string}` {
  return encodePacked(["address", "uint24", "address"], [weth, hop, quote]);
}

/** The calls of a launch, in order: the quote's approval when the dev buy needs one, the
 *  launch, the guard on the predicted address (setFeeRecipient, the creator's alone), the
 *  dev buy. Without a dev buy, the launch alone. */
export function launchCalls(l: Launch): Call[] {
  const calls: Call[] = [];
  if (l.devBuy?.kind === "quote" && l.devBuy.approve) {
    calls.push({ to: l.devBuy.quote, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [l.pad, l.devBuy.amount] }) });
  }
  calls.push({
    to: l.pad,
    data: encodeFunctionData({
      abi: launchpadAbi,
      functionName: "createTokenWithFees",
      args: [l.name, l.symbol, 0n, l.meta, l.quoteAsset, l.fees],
    }),
  });
  if (!l.devBuy) return calls;
  calls.push({
    to: l.pad,
    data: encodeFunctionData({ abi: launchpadAbi, functionName: "setFeeRecipient", args: [l.token, ZERO_ADDRESS] }),
  });
  if (l.devBuy.kind === "quote") {
    calls.push({
      to: l.pad,
      data: encodeFunctionData({ abi: launchpadAbi, functionName: "buyWithQuote", args: [l.token, l.devBuy.amount, l.devBuy.minTokensOut] }),
    });
  } else {
    calls.push({
      to: l.devBuy.zap,
      data: encodeFunctionData({
        abi: zapRouterAbi,
        functionName: "zapBuy",
        args: [l.token, l.devBuy.path, l.devBuy.minQuoteOut, l.devBuy.minTokensOut],
      }),
      value: l.devBuy.value,
    });
  }
  return calls;
}
