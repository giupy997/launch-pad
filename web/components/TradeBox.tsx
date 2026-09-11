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
  type CurveInfo,
} from "@/lib/hooks";
import { fmtUnits, fmtTokens } from "@/lib/format";
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
  feesToHolders = false,
}: {
  token: `0x${string}`;
  symbol: string;
  curve: CurveInfo;
  feesToHolders?: boolean;
}) {
  const padMaybe = useLaunchpadAddress();
  const deployed = !!padMaybe;
  const pad = padMaybe ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);
  const explorer = useExplorer();
  const chain = useAppChain();
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
  const usdgAddr = USDG[chain.id];
  const zapFees = (QUOTE_ASSETS[chain.id] ?? []).find(
    (a) => a.address?.toLowerCase() === curve.quoteAsset.toLowerCase()
  )?.zapFees;
  const canZap = !isEthQuote && !!zapAddr && !!quoterAddr && !!wethAddr && !!zapFees;
  const zapMode = mode === "buy" && canZap && payWithEth;

  const zapPath =
    canZap && wethAddr && q.address
      ? zapFees!.length === 2 && usdgAddr
        ? encodePacked(
            ["address", "uint24", "address", "uint24", "address"],
            [wethAddr, zapFees![0], usdgAddr, zapFees![1], q.address]
          )
        : encodePacked(["address", "uint24", "address"], [wethAddr, zapFees![0], q.address])
      : undefined;

  const parsed = safeParse(amount, mode === "buy" ? (zapMode ? 18 : q.decimals) : 18);

  // ETH -> quote estimate via the Uniswap quoter
  const { data: quoterSim } = useSimulateContract({
    address: quoterAddr,
    abi: quoterAbi,
    functionName: "quoteExactInput",
    args: zapPath ? [zapPath, parsed] : undefined,
    chainId: chain.id,
    query: { enabled: zapMode && !!zapPath && parsed > 0n, refetchInterval: 10_000 },
  });
  const zapQuoteOut = quoterSim?.result?.[0] as bigint | undefined;

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

  const buyAmountForQuote = zapMode ? (zapQuoteOut ?? 0n) : parsed;
  const { data: buyQuote } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "quoteBuy",
    args: [token, buyAmountForQuote],
    query: { enabled: mode === "buy" && buyAmountForQuote > 0n, refetchInterval: 5_000 },
  });

  const { data: sellQuote } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "quoteSell",
    args: [token, parsed],
    query: { enabled: mode === "sell" && parsed > 0n, refetchInterval: 5_000 },
  });

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
      if (zapMode && zapPath && zapAddr) {
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
      <div className="rounded-xl border border-zinc-700 bg-black p-5 h-fit">
        <p className="text-sm text-zinc-300">
          🎓 Curve completed: trading here is closed. This token now trades on
          the DEX, paired with {q.symbol}.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-black p-5 h-fit space-y-4">
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
            {(["ETH", q.symbol] as const).map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => setPayWithEth(i === 0)}
                className={`rounded-full px-2.5 py-1 text-xs font-mono ${
                  (i === 0) === payWithEth
                    ? "bg-white text-black"
                    : "border border-zinc-700 text-zinc-400 hover:border-white hover:text-white"
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
            placeholder={mode === "buy" ? `${zapMode ? "ETH" : q.symbol} to spend` : `${symbol} to sell`}
            type="number"
            step="any"
            min="0"
            className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none"
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
            mode === "buy" ? "bg-white hover:bg-zinc-200" : "bg-zinc-300 hover:bg-white"
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
        1% fee · {feesToHolders ? "80% holder cashback" : "80% creator"} · 20% treasury
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
