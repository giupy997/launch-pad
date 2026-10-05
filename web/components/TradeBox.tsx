"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { encodePacked, erc20Abi, formatUnits, maxUint256, parseUnits } from "viem";
import {
  useAccount,
  useBalance,
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
  useDebounced,
} from "@/lib/hooks";
import { fmtEth, fmtUnits, fmtTokens } from "@/lib/format";
import { quoteBuy, quoteSell, parseFeeConfig, NO_TAX, feeLabel, splitParts, type FeeConfig } from "@/lib/curve";
import { SlippageControl, useSlippageBps } from "@/components/SlippageControl";
import { PoolCard } from "@/components/PoolCard";
import { QUOTE_ASSETS, ZAP_ROUTER, UNISWAP_QUOTER, WETH9, USDG } from "@/lib/config";
import { fmtPoints, pointsFor, usePointsChain, useSeason } from "@/lib/points/client";

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

/** what "Max" keeps back when the side being spent is the chain's own coin: gas for the trade */
const GAS_RESERVE = 300_000_000_000_000n; // 0.0003 ETH
const PICKS = [25, 50, 75, 100] as const;

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
  // a quick pick (25/50/75/Max): the trade moves that share of the live balance, the field shows it rounded
  const [pct, setPct] = useState<number | null>(null);
  const [payWithEth, setPayWithEth] = useState(true);

  const q = quoteInfo(chain.id, curve.quoteAsset);
  const isEthQuote = q.address === null;
  const graduated = curve.graduated;
  // the points a trade earns, where a season runs (LitVM); nothing elsewhere
  const pointsChain = usePointsChain();
  const seasonName = useSeason(pointsChain?.key ?? null).data?.season?.name;

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

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: "balanceOf",
    args: user ? [user] : undefined,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: "allowance",
    args: user ? [user, pad] : undefined,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });

  // ERC-20 quote curves: quote-asset allowance and balance for the buy side
  const { data: quoteAllowance, refetch: refetchQuoteAllowance } = useReadContract({
    address: q.address ?? undefined,
    abi: erc20Abi,
    functionName: "allowance",
    args: user && q.address ? [user, pad] : undefined,
    query: { enabled: !!user && !!q.address, refetchInterval: 5_000 },
  });

  const { data: quoteBalance, refetch: refetchQuoteBalance } = useReadContract({
    address: q.address ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: user && q.address ? [user] : undefined,
    query: { enabled: !!user && !!q.address, refetchInterval: 5_000 },
  });

  // the chain's own coin, for buys paid in it
  const { data: ethBal, refetch: refetchEthBal } = useBalance({
    address: user,
    chainId: chain.id,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });

  // What this side spends: its balance as shown, and what the quick picks
  // share out (the native coin less a gas reserve, so "Max" still sends).
  const spendsEth = mode === "buy" && (zapMode || isEthQuote);
  const inputDecimals = mode === "buy" ? (zapMode ? 18 : q.decimals) : 18;
  const sideBalance: bigint | undefined =
    mode === "sell"
      ? (balance as bigint | undefined)
      : spendsEth
        ? ethBal?.value
        : (quoteBalance as bigint | undefined);
  const balanceLabel =
    sideBalance === undefined
      ? undefined
      : mode === "sell"
        ? `${fmtTokens(sideBalance)} ${symbol}`
        : spendsEth
          ? `${fmtEth(sideBalance)} ${native}`
          : `${fmtUnits(sideBalance, q.decimals)} ${q.symbol}`;
  const spendable: bigint | undefined =
    sideBalance === undefined ? undefined : spendsEth ? (sideBalance > GAS_RESERVE ? sideBalance - GAS_RESERVE : 0n) : sideBalance;
  const picked = pct !== null && spendable !== undefined ? (spendable * BigInt(pct)) / 100n : undefined;
  const shown = picked !== undefined ? fmtInput(picked, inputDecimals) : amount;
  const parsed = picked ?? safeParse(amount, inputDecimals);

  function editAmount(v: string) {
    setPct(null);
    setAmount(v);
  }
  function pick(p: number) {
    setPct(p);
    if (spendable !== undefined) setAmount(fmtInput((spendable * BigInt(p)) / 100n, inputDecimals));
  }

  // ETH -> quote estimate via the Uniswap quoter (pool route): an RPC call, so it
  // reads the amount once typing has paused, not once per key
  const quotedIn = useDebounced(parsed, 250);
  const { data: quoterSim } = useSimulateContract({
    address: quoterAddr,
    abi: quoterAbi,
    functionName: "quoteExactInput",
    args: zapPath ? [zapPath, quotedIn] : undefined,
    chainId: chain.id,
    query: { enabled: zapMode && !curveZapMode && !!zapPath && quotedIn > 0n, refetchInterval: 10_000, retry: 1, staleTime: 8_000 },
  });
  const quoting = zapMode && !curveZapMode && parsed > 0n && (quotedIn !== parsed || quoterSim === undefined);

  // ETH -> pre-market estimate straight from its own curve (curve route): the pad's arithmetic, run here
  const preQuoteOut: bigint | undefined =
    curveZapMode && preCurveRaw && parsed > 0n
      ? quoteBuy(parseCurve(preCurveRaw), parsed, platformFeeBps, preFeesRaw ? parseFeeConfig(preFeesRaw) : NO_TAX)
      : undefined;

  const zapQuoteOut = curveZapMode ? preQuoteOut : (quoterSim?.result?.[0] as bigint | undefined);

  // what the curve pays or gives, computed here from its reserves and the coin's fees
  const buyAmountForQuote = zapMode ? (zapQuoteOut ?? 0n) : parsed;
  const buyQuote: bigint | undefined =
    mode === "buy" && buyAmountForQuote > 0n ? quoteBuy(curve, buyAmountForQuote, platformFeeBps, fees) : undefined;
  const sellQuote: bigint | undefined =
    mode === "sell" && parsed > 0n ? quoteSell(curve, parsed, platformFeeBps, fees) : undefined;

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const queryClient = useQueryClient();

  // What the last signed transaction was. A confirmed approval refreshes the
  // allowance at once (not on the next poll) so the button turns into
  // Buy/Sell; a confirmed trade refreshes everything the page reads — the
  // curve, the balances, the trades, the volumes — now, not on the next poll,
  // and clears the field.
  const [lastAction, setLastAction] = useState<"approve" | "trade">("trade");
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isSuccess || !hash || handled.current === hash) return;
    handled.current = hash;
    if (lastAction === "approve") {
      refetchAllowance();
      refetchQuoteAllowance();
    } else {
      refetchBalance();
      refetchQuoteBalance();
      refetchEthBal();
      setPct(null);
      setAmount("");
      refreshAfterTrade(queryClient);
    }
  }, [isSuccess, hash, lastAction, refetchAllowance, refetchQuoteAllowance, refetchBalance, refetchQuoteBalance, refetchEthBal, queryClient]);

  // Buy and Sell take different units, so the field and the last
  // transaction's outcome don't carry over from one side to the other.
  function switchMode(m: "buy" | "sell") {
    if (m === mode) return;
    setMode(m);
    setPct(null);
    setAmount("");
    reset();
  }
  function switchPayWith(eth: boolean) {
    if (eth === payWithEth) return;
    setPayWithEth(eth);
    setPct(null);
    setAmount("");
  }

  // Approvals are granted once, unlimited, to the pad: it only ever pulls
  // tokens from msg.sender inside sell/buyWithQuote, so the allowance is
  // spendable by this wallet's own trades alone. Exact-amount approvals
  // meant an Approve before every single trade.
  const needsSellApproval =
    mode === "sell" && parsed > 0n && (allowance === undefined || (allowance as bigint) < parsed);
  const needsBuyApproval =
    mode === "buy" &&
    !isEthQuote &&
    !zapMode &&
    parsed > 0n &&
    (quoteAllowance === undefined || (quoteAllowance as bigint) < parsed);
  const needsApproval = needsBuyApproval || needsSellApproval;

  function withSlippage(quote: bigint): bigint {
    return quote - (quote * BigInt(slippageBps)) / 10_000n;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    reset();
    setLastAction(needsApproval ? "approve" : "trade");
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
          args: [pad, maxUint256],
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
        args: [pad, maxUint256],
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

  if (graduated) return <PoolCard token={token} symbol={symbol} quote={q} />;

  return (
    <div className="card p-5 h-fit space-y-4">
      <div className="grid grid-cols-2 rounded-lg bg-zinc-900 p-1 text-sm font-semibold">
        <Tab active={mode === "buy"} onClick={() => switchMode("buy")}>
          Buy
        </Tab>
        <Tab active={mode === "sell"} onClick={() => switchMode("sell")}>
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
                onClick={() => switchPayWith(i === 0)}
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
            value={shown}
            onChange={(e) => editAmount(e.target.value)}
            placeholder={mode === "buy" ? `${zapMode ? native : q.symbol} to spend` : `${symbol} to sell`}
            type="number"
            step="any"
            min="0"
            className="w-full rounded-lg input px-3 py-2 text-sm focus:border-white outline-none"
          />
          {isConnected && balanceLabel && (
            <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-zinc-500">
              <span>Balance: {balanceLabel}</span>
              <div className="flex gap-1">
                {PICKS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={!spendable}
                    onClick={() => pick(p)}
                    title={p === 100 && spendsEth ? `Keeps ${formatUnits(GAS_RESERVE, 18)} ${native} for gas` : undefined}
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] disabled:opacity-40 ${
                      pct === p
                        ? "bg-white text-black"
                        : "border border-white/15 text-zinc-400 hover:border-white hover:text-white"
                    }`}
                  >
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {parsed > 0n && mode === "buy" && buyQuote === undefined && quoting && (
          <p className="text-sm text-zinc-600">≈ quoting…</p>
        )}
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
        {pointsChain && seasonName && parsed > 0n && (() => {
          const quoteMoved = mode === "buy" ? buyAmountForQuote : ((sellQuote as bigint | undefined) ?? 0n);
          const pts = pointsFor(quoteMoved, q.decimals);
          return pts > 0 ? (
            <p className="font-mono text-[10px] tracking-widest uppercase text-zinc-600">
              +{fmtPoints(pts)} pts · {seasonName}
            </p>
          ) : null;
        })()}

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
                  ? lastAction === "approve"
                    ? "Approving…"
                    : "Confirming…"
                  : needsBuyApproval
                    ? `Approve ${q.symbol}`
                    : needsSellApproval
                      ? `Approve ${symbol}`
                      : mode === "buy"
                        ? "Buy"
                        : "Sell"}
        </button>
        {needsApproval && isConnected && !isPending && !isConfirming && (
          <p className="text-xs text-zinc-500">
            One-time approval: it lets the launchpad take the {needsBuyApproval ? q.symbol : symbol} you
            trade, and only your own trades can spend it. You won&apos;t be asked again
            {needsBuyApproval ? ` when paying with ${q.symbol}` : " for this coin"}.
          </p>
        )}
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
          {lastAction === "approve" ? `Approved: press ${mode === "buy" ? "Buy" : "Sell"} to trade.` : "Done!"}{" "}
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

/** Everything a trade changes, asked again at once: wagmi's contract reads and
 *  balances (the curve, the pool, the allowances), and the site's own scans
 *  (trades, volumes, holders). Polls would get there in five to fifteen
 *  seconds; a trade should show the moment it lands. */
export function refreshAfterTrade(queryClient: ReturnType<typeof useQueryClient>) {
  for (const key of ["readContract", "readContracts", "balance", "trades", "volumes-24h", "holders"]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

function safeParse(v: string, decimals: number): bigint {
  try {
    return v ? parseUnits(v, decimals) : 0n;
  } catch {
    return 0n;
  }
}

/** an amount as the input field shows it: four decimals (six below one), no trailing zeros */
function fmtInput(wei: bigint, decimals: number): string {
  const [int, frac = ""] = formatUnits(wei, decimals).split(".");
  const f = frac.slice(0, int === "0" ? 6 : 4).replace(/0+$/, "");
  return f ? `${int}.${f}` : int;
}
