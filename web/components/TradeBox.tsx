"use client";

import { useState } from "react";
import { encodePacked, erc20Abi, parseUnits } from "viem";
import {
  useAccount,
  useReadContract,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { launchpadAbi, launchTokenAbi } from "@/lib/abi";
import {
  useLaunchpadAddress,
  useExplorer,
  useAppChain,
  quoteInfo,
  parseCurve,
  type CurveInfo,
  useNativeSymbol,
} from "@/lib/hooks";
import { fmtUnits, fmtTokens } from "@/lib/format";
import { quoteBuy, quoteSell, parseFeeConfig, NO_TAX, feeLabel, splitParts, type FeeConfig } from "@/lib/curve";
import { SlippageControl, useSlippageBps } from "@/components/SlippageControl";
import { QUOTE_ASSETS, ZAP_ROUTER, UNISWAP_QUOTER, WETH9, USDG } from "@/lib/config";

const zapRouterAbi = [
  {
    type: "function",
    name: "zapBuy",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "path", type: "bytes" },
      { name: "minQuoteOut", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "zapBuyCurve",
    stateMutability: "payable",
    inputs: [
      { name: "token", type: "address" },
      { name: "minQuoteOut", type: "uint256" },
      { name: "minTokensOut", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export function TradeBox({
  token,
  symbol,
  curve,
  fees = NO_TAX,
  platformFeeBps = 100n,
  treasury = "0.2%",
}: {
  token: `0x${string}`;
  symbol: string;
  curve: CurveInfo;
  /** the coin's own tax and split (none on pads before v9) */
  fees?: FeeConfig;
  /** the pad's platform fee, basis points */
  platformFeeBps?: bigint;
  /** the treasury's cut of a trade, as text */
  treasury?: string;
}) {
  const padMaybe = useLaunchpadAddress();
  const deployed = !!padMaybe;
  const pad = padMaybe ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);
  const explorer = useExplorer();
  const chain = useAppChain();
  const native = useNativeSymbol();
  const { address: user, isConnected } = useAccount();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [slippageBps, setSlippageBps] = useSlippageBps();
  const [amount, setAmount] = useState("");
  const [payWithEth, setPayWithEth] = useState(true);

  const q = quoteInfo(chain.id, curve.quoteAsset);
  const isEthQuote = q.address === null;
  const graduated = curve.graduated;

  // ETH zap route for asset-quoted curves (registry-driven)
  const zapAddr = ZAP_ROUTER[chain.id];
  const quoterAddr = UNISWAP_QUOTER[chain.id];
  const wethAddr = WETH9[chain.id];
  const zapInfo = (QUOTE_ASSETS[chain.id] ?? []).find((a) => a.address?.toLowerCase() === curve.quoteAsset.toLowerCase());
  const zapFees = zapInfo?.zapFees;
  // the middle token of a two-hop route: the asset's own, else the chain's USDG
  const zapVia = zapInfo?.zapVia ?? USDG[chain.id];
  const canZapPool = !isEthQuote && !!zapAddr && !!quoterAddr && !!wethAddr && !!zapFees;

  // Synthetic pre-market quote with its own curve still open: ETH routes
  // through ZapRouter.zapBuyCurve (buy the pre-market on ITS curve, then buy
  // this token with it) — no Uniswap pool involved.
  const { data: preCurveRaw } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "curves",
    args: q.address ? [q.address] : undefined,
    chainId: chain.id,
    query: { enabled: q.synthetic && !!q.address, refetchInterval: 15_000 },
  });
  const { data: preFeesRaw } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "feeConfig",
    args: q.address ? [q.address] : undefined,
    chainId: chain.id,
    query: { enabled: q.synthetic && !!q.address, staleTime: Infinity },
  });
  const canZapCurve =
    q.synthetic && !!zapAddr && !!preCurveRaw && !parseCurve(preCurveRaw).graduated;

  const canZap = canZapPool || canZapCurve;
  const zapMode = mode === "buy" && canZap && payWithEth;
  const curveZapMode = zapMode && canZapCurve;

  const zapPath =
    canZapPool && wethAddr && q.address
      ? zapFees!.length === 2 && zapVia
        ? encodePacked(
            ["address", "uint24", "address", "uint24", "address"],
            [wethAddr, zapFees![0], zapVia, zapFees![1], q.address]
          )
        : encodePacked(["address", "uint24", "address"], [wethAddr, zapFees![0], q.address])
      : undefined;

  const parsed = safeParse(amount, mode === "buy" ? (zapMode ? 18 : q.decimals) : 18);

  // ETH -> quote estimate via the Uniswap quoter (pool route)
  const { data: quoterSim } = useSimulateContract({
    address: quoterAddr,
    abi: quoterAbi,
    functionName: "quoteExactInput",
    args: zapPath ? [zapPath, parsed] : undefined,
    chainId: chain.id,
    query: { enabled: zapMode && !curveZapMode && !!zapPath && parsed > 0n, refetchInterval: 10_000 },
  });

  // ETH -> pre-market estimate straight from its own curve (curve route): the pad's arithmetic, run here
  const preQuoteOut: bigint | undefined =
    curveZapMode && preCurveRaw && parsed > 0n
      ? quoteBuy(parseCurve(preCurveRaw), parsed, platformFeeBps, preFeesRaw ? parseFeeConfig(preFeesRaw) : NO_TAX)
      : undefined;

  const zapQuoteOut = curveZapMode ? preQuoteOut : (quoterSim?.result?.[0] as bigint | undefined);

  const { data: balance } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: "balanceOf",
    args: user ? [user] : undefined,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });

  const { data: allowance } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: "allowance",
    args: user ? [user, pad] : undefined,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });

  // ERC-20 quote curves: quote-asset allowance and balance for the buy side
  const { data: quoteAllowance } = useReadContract({
    address: q.address ?? undefined,
    abi: erc20Abi,
    functionName: "allowance",
    args: user && q.address ? [user, pad] : undefined,
    query: { enabled: !!user && !!q.address, refetchInterval: 5_000 },
  });

  const { data: quoteBalance } = useReadContract({
    address: q.address ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: user && q.address ? [user] : undefined,
    query: { enabled: !!user && !!q.address, refetchInterval: 5_000 },
  });

  // what the curve pays or gives, computed here from its reserves and the coin's fees
  const buyAmountForQuote = zapMode ? (zapQuoteOut ?? 0n) : parsed;
  const buyQuote: bigint | undefined =
    mode === "buy" && buyAmountForQuote > 0n ? quoteBuy(curve, buyAmountForQuote, platformFeeBps, fees) : undefined;
  const sellQuote: bigint | undefined =
    mode === "sell" && parsed > 0n ? quoteSell(curve, parsed, platformFeeBps, fees) : undefined;

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const needsSellApproval =
    mode === "sell" && parsed > 0n && (allowance === undefined || (allowance as bigint) < parsed);
  const needsBuyApproval =
    mode === "buy" &&
    !isEthQuote &&
    !zapMode &&
    parsed > 0n &&
    (quoteAllowance === undefined || (quoteAllowance as bigint) < parsed);

  function withSlippage(quote: bigint): bigint {
    return quote - (quote * BigInt(slippageBps)) / 10_000n;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    reset();
    if (mode === "buy") {
      if (curveZapMode && zapAddr) {
        writeContract({
          address: zapAddr,
          abi: zapRouterAbi,
          functionName: "zapBuyCurve",
          chainId: chain.id,
          args: [
            token,
            zapQuoteOut !== undefined ? withSlippage(zapQuoteOut) : 0n,
            buyQuote !== undefined ? withSlippage(buyQuote as bigint) : 0n,
          ],
          value: parsed,
        });
      } else if (zapMode && zapPath && zapAddr) {
        writeContract({
          address: zapAddr,
          abi: zapRouterAbi,
          functionName: "zapBuy",
          chainId: chain.id,
          args: [
            token,
            zapPath,
            zapQuoteOut !== undefined ? withSlippage(zapQuoteOut) : 0n,
            buyQuote !== undefined ? withSlippage(buyQuote as bigint) : 0n,
          ],
          value: parsed,
        });
      } else if (isEthQuote) {
        writeContract({
          address: pad,
          abi: launchpadAbi,
          functionName: "buy",
          chainId: chain.id,
          args: [token, buyQuote !== undefined ? withSlippage(buyQuote as bigint) : 0n],
          value: parsed,
        });
      } else if (needsBuyApproval) {
        writeContract({
          address: q.address!,
          abi: erc20Abi,
          functionName: "approve",
          chainId: chain.id,
          args: [pad, parsed],
        });
      } else {
        writeContract({
          address: pad,
          abi: launchpadAbi,
          functionName: "buyWithQuote",
          chainId: chain.id,
          args: [token, parsed, buyQuote !== undefined ? withSlippage(buyQuote as bigint) : 0n],
        });
      }
    } else if (needsSellApproval) {
      writeContract({
        address: token,
        abi: launchTokenAbi,
        functionName: "approve",
        chainId: chain.id,
        args: [pad, parsed],
      });
    } else {
      writeContract({
        address: pad,
        abi: launchpadAbi,
        functionName: "sell",
        chainId: chain.id,
        args: [token, parsed, sellQuote !== undefined ? withSlippage(sellQuote as bigint) : 0n],
      });
    }
  }

  if (graduated) {
    return (
      <div className="card p-5 h-fit">
        <p className="text-sm text-zinc-300">
          🎓 Curve completed: trading here is closed. This token now trades in its pool on the DEX, paired with{" "}
          {q.symbol}, with liquidity locked forever.
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          The launchpad&apos;s fees ended with the curve; the pool keeps its own swap fee for its liquidity.
        </p>
      </div>
    );
  }

  return (
    <div className="card p-5 h-fit space-y-4">
      <div className="grid grid-cols-2 rounded-lg bg-zinc-900 p-1 text-sm font-semibold">
        <Tab active={mode === "buy"} onClick={() => setMode("buy")}>
          Buy
        </Tab>
        <Tab active={mode === "sell"} onClick={() => setMode("sell")}>
          Sell
        </Tab>
      </div>

      <form onSubmit={submit} className="space-y-3">
        {mode === "buy" && canZap && (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mr-1">
              Pay with
            </span>
            {([native, q.symbol] as const).map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => setPayWithEth(i === 0)}
                className={`rounded-full px-2.5 py-1 text-xs font-mono ${
                  (i === 0) === payWithEth
                    ? "bg-white text-black"
                    : "border border-white/15 text-zinc-400 hover:border-white hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={mode === "buy" ? `${zapMode ? native : q.symbol} to spend` : `${symbol} to sell`}
            type="number"
            step="any"
            min="0"
            className="w-full rounded-lg input px-3 py-2 text-sm focus:border-white outline-none"
          />
          {mode === "buy" && !isEthQuote && quoteBalance !== undefined && (
            <p className="mt-1 text-xs text-zinc-500">
              Balance: {fmtUnits(quoteBalance as bigint, q.decimals)} {q.symbol}
            </p>
          )}
          {mode === "sell" && balance !== undefined && (
            <button
              type="button"
              onClick={() => setAmount(fmtRaw(balance as bigint))}
              className="mt-1 text-xs text-zinc-500 underline"
            >
              Max: {fmtTokens(balance as bigint)} {symbol}
            </button>
          )}
        </div>

        {parsed > 0n && mode === "buy" && buyQuote !== undefined && (
          <p className="text-sm text-zinc-400">
            ≈ {fmtTokens(buyQuote as bigint)} {symbol}
            {zapMode && zapQuoteOut !== undefined && (
              <span className="text-zinc-600"> · via {fmtUnits(zapQuoteOut, q.decimals)} {q.symbol}</span>
            )}
          </p>
        )}
        {parsed > 0n && mode === "sell" && sellQuote !== undefined && (
          <p className="text-sm text-zinc-400">
            ≈ {fmtUnits(sellQuote as bigint, q.decimals)} {q.symbol}
          </p>
        )}

        <button
          type="submit"
          disabled={!deployed || !isConnected || parsed === 0n || isPending || isConfirming}
          className={`w-full rounded-lg py-2.5 font-semibold text-black disabled:opacity-40 ${
            mode === "buy" ? "bg-white hover:bg-zinc-100 transition-colors" : "bg-zinc-300 hover:bg-white"
          }`}
        >
          {!deployed
            ? "Not deployed on this chain"
            : !isConnected
              ? "Connect wallet"
              : isPending
                ? "Sign in wallet…"
                : isConfirming
                  ? "Confirming…"
                  : needsBuyApproval
                    ? `Approve ${q.symbol}`
                    : needsSellApproval
                      ? `Approve ${symbol}`
                      : mode === "buy"
                        ? "Buy"
                        : "Sell"}
        </button>
      </form>

      <SlippageControl bps={slippageBps} onChange={setSlippageBps} />
      <p className="text-xs text-zinc-600">
        {mode === "buy" ? "Buy" : "Sell"} fee {feeLabel(platformFeeBps, mode === "buy" ? fees.buyTaxBps : fees.sellTaxBps)} ·{" "}
        {splitParts(fees)
          .map((p) => `${p.bps / 100}% ${p.label}`)
          .join(" · ")}{" "}
        · {treasury} treasury
      </p>

      {isSuccess && hash && (
        <p className="text-sm text-zinc-300">
          Done!{" "}
          <a href={`${explorer}/tx/${hash}`} target="_blank" className="underline">
            tx
          </a>
        </p>
      )}
      {error && (
        <p className="text-sm text-zinc-400 break-all">
          {(error as { shortMessage?: string }).shortMessage ?? error.message}
        </p>
      )}
    </div>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const activeCls = "bg-white text-black";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md py-1.5 ${active ? activeCls : "text-zinc-400"}`}
    >
      {children}
    </button>
  );
}

function safeParse(v: string, decimals: number): bigint {
  try {
    return v ? parseUnits(v, decimals) : 0n;
  } catch {
    return 0n;
  }
}

function fmtRaw(wei: bigint): string {
  // full-precision decimal string for the input field
  const s = wei.toString().padStart(19, "0");
  const int = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
