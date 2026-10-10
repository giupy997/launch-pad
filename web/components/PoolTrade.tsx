"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { erc20Abi, formatUnits, maxUint256, parseAbi, parseUnits } from "viem";
import { useAccount, useBalance, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchTokenAbi, type PadVersion } from "@/lib/abi";
import { useAppChain, useExplorer, useNativeSymbol } from "@/lib/hooks";
import { netOfRate, poolRate, sideFeeLabel, type FeeConfig } from "@/lib/curve";
import { fmtEth, fmtTokens, fmtUnits } from "@/lib/format";
import type { PoolInfo } from "@/lib/pool";
import { SlippageControl, useSlippageBps } from "@/components/SlippageControl";
import { refreshAfterTrade } from "@/components/TradeBox";

// The Uniswap v2 router's exact-input swaps that measure what the pair really
// received and what the wallet really got, instead of trusting the pair's
// arithmetic: the only ones that work on a v12 coin, whose token keeps a share
// of every transfer out of or into its pool. They serve an untaxed (v11) pool
// the same, so both pads go through them and the plain ones are gone.
// Exact output is never offered (it was not before either): the router's
// ...ForExactTokens functions size the input from the reserves alone and know
// nothing of the token's charge, so on a taxed coin a buy delivers less than
// asked for and a sell reverts, the pair getting fewer coins than counted on.
const routerAbi = parseAbi([
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const GAS_RESERVE = 300_000_000_000_000n; // 0.0003 of the chain's coin kept for gas
const PICKS = [25, 50, 75, 100] as const;

/** Uniswap v2's getAmountOut: the 0.3% fee on the way in. */
function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) return 0n;
  const inWithFee = amountIn * 997n;
  return (inWithFee * reserveOut) / (reserveIn * 1000n + inWithFee);
}

/** Buy and sell a graduated coin in its pool, through the Uniswap v2 router
 *  the pad seeded it on. The quote is what the pool is paired with: the
 *  curve's ERC-20 quote, or the chain's own coin for a native curve. On v12
 *  the quotes are net of what the token keeps on the way through the pool. */
export function PoolTrade({
  token,
  symbol,
  quote,
  pool,
  fees,
  version,
}: {
  token: `0x${string}`;
  symbol: string;
  quote: { symbol: string; decimals: number; address: `0x${string}` | null };
  pool: PoolInfo;
  /** the coin's fee configuration: on v12 its pool charges platformBps plus the side's tax, in coins */
  fees: FeeConfig;
  /** the pad's generation: a v11 pool pays nothing to the pad or the coin */
  version: PadVersion;
}) {
  const chain = useAppChain();
  const explorer = useExplorer();
  const native = useNativeSymbol();
  const { address: user, isConnected } = useAccount();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [pct, setPct] = useState<number | null>(null);
  const [slippageBps, setSlippageBps] = useSlippageBps();
  const isNative = quote.address === null;
  const router = pool.router;

  // the wallet's side, read on the app chain (not on whatever chain the wallet sits on)
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: "balanceOf",
    args: user ? [user] : undefined,
    chainId: chain.id,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: "allowance",
    args: user ? [user, router] : undefined,
    chainId: chain.id,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });
  const { data: quoteBalance, refetch: refetchQuoteBalance } = useReadContract({
    address: quote.address ?? undefined,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: user && quote.address ? [user] : undefined,
    chainId: chain.id,
    query: { enabled: !!user && !isNative, refetchInterval: 5_000 },
  });
  const { data: quoteAllowance, refetch: refetchQuoteAllowance } = useReadContract({
    address: quote.address ?? undefined,
    abi: erc20Abi,
    functionName: "allowance",
    args: user && quote.address ? [user, router] : undefined,
    chainId: chain.id,
    query: { enabled: !!user && !isNative, refetchInterval: 5_000 },
  });
  const { data: ethBal, refetch: refetchEthBal } = useBalance({
    address: user,
    chainId: chain.id,
    query: { enabled: !!user && isNative, refetchInterval: 5_000 },
  });

  const inputDecimals = mode === "buy" ? quote.decimals : 18;
  const sideBalance: bigint | undefined =
    mode === "sell" ? (balance as bigint | undefined) : isNative ? ethBal?.value : (quoteBalance as bigint | undefined);
  const spendable: bigint | undefined =
    sideBalance === undefined
      ? undefined
      : mode === "buy" && isNative
        ? sideBalance > GAS_RESERVE
          ? sideBalance - GAS_RESERVE
          : 0n
        : sideBalance;
  const picked = pct !== null && spendable !== undefined ? (spendable * BigInt(pct)) / 100n : undefined;
  const shown = picked !== undefined ? fmtInput(picked, inputDecimals) : amount;
  const parsed = picked ?? safeParse(amount, inputDecimals);
  const balanceLabel =
    sideBalance === undefined
      ? undefined
      : mode === "sell"
        ? `${fmtTokens(sideBalance)} ${symbol}`
        : isNative
          ? `${fmtEth(sideBalance)} ${native}`
          : `${fmtUnits(sideBalance, quote.decimals)} ${quote.symbol}`;

  // What this side pays over the pool's own 0.3%: on v12 the launchpad's rate
  // and the coin's tax, which the token keeps, in coins, on every transfer out
  // of the pool (a buy) or into it (a sell) — the pad's transferRate, one floor
  // division (netOfRate). A v11 pool pays nothing to the pad or the coin.
  const rateBps = version === 12 ? poolRate(fees, mode) : 0;
  // what the pool itself takes in and gives, from its reserves as last read: on
  // a sell the token keeps its share before the coins reach the pair, on a buy
  // after they leave it; `out` is what reaches the wallet
  const poolIn = mode === "sell" ? netOfRate(parsed, rateBps) : parsed;
  const poolOut =
    mode === "buy"
      ? amountOut(poolIn, pool.quoteReserve, pool.tokenReserve)
      : amountOut(poolIn, pool.tokenReserve, pool.quoteReserve);
  const out = mode === "buy" ? netOfRate(poolOut, rateBps) : poolOut;
  // the price the pool dealt at against its spot: the pool's own move, the charge told beside it
  const spot = Number(pool.quoteReserve) / Number(pool.tokenReserve || 1n);
  const dealt = poolOut > 0n ? (mode === "buy" ? Number(poolIn) / Number(poolOut) : Number(poolOut) / Number(poolIn)) : spot;
  const impactPct = poolOut > 0n ? Math.max(0, (mode === "buy" ? dealt / spot - 1 : 1 - dealt / spot) * 100) : 0;
  // the least the wallet must receive, which the router checks: the net figure less the slippage allowed
  const minOut = out - (out * BigInt(slippageBps)) / 10_000n;
  const charge = rateBps > 0 ? rateLine(fees, mode) : null;

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash, chainId: chain.id });
  const queryClient = useQueryClient();
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
      refreshAfterTrade(queryClient); // the pool's reserves, the trades, the volume: now
    }
  }, [isSuccess, hash, lastAction, refetchAllowance, refetchQuoteAllowance, refetchBalance, refetchQuoteBalance, refetchEthBal, queryClient]);

  function switchMode(m: "buy" | "sell") {
    if (m === mode) return;
    setMode(m);
    setPct(null);
    setAmount("");
    reset();
  }
  function pick(p: number) {
    setPct(p);
    if (spendable !== undefined) setAmount(fmtInput((spendable * BigInt(p)) / 100n, inputDecimals));
  }

  // one unlimited approval to the router, like the pad's: it only pulls from msg.sender inside a swap
  const needsSellApproval = mode === "sell" && parsed > 0n && (allowance === undefined || (allowance as bigint) < parsed);
  const needsBuyApproval =
    mode === "buy" && !isNative && parsed > 0n && (quoteAllowance === undefined || (quoteAllowance as bigint) < parsed);
  const needsApproval = needsBuyApproval || needsSellApproval;
  const canTrade = isConnected && parsed > 0n && (needsApproval || out > 0n) && (spendable === undefined || parsed <= (sideBalance ?? 0n));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    reset();
    setLastAction(needsApproval ? "approve" : "trade");
    const deadline = swapDeadline();
    if (!user) return;
    if (mode === "buy") {
      if (isNative) {
        writeContract({
          address: router,
          abi: routerAbi,
          functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
          chainId: chain.id,
          args: [minOut, [pool.pairAsset, token], user, deadline],
          value: parsed,
        });
      } else if (needsBuyApproval) {
        writeContract({ address: quote.address!, abi: erc20Abi, functionName: "approve", chainId: chain.id, args: [router, maxUint256] });
      } else {
        writeContract({
          address: router,
          abi: routerAbi,
          functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
          chainId: chain.id,
          args: [parsed, minOut, [pool.pairAsset, token], user, deadline],
        });
      }
    } else if (needsSellApproval) {
      writeContract({ address: token, abi: launchTokenAbi, functionName: "approve", chainId: chain.id, args: [router, maxUint256] });
    } else if (isNative) {
      writeContract({
        address: router,
        abi: routerAbi,
        functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens",
        chainId: chain.id,
        args: [parsed, minOut, [token, pool.pairAsset], user, deadline],
      });
    } else {
      writeContract({
        address: router,
        abi: routerAbi,
        functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
        chainId: chain.id,
        args: [parsed, minOut, [token, pool.pairAsset], user, deadline],
      });
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 rounded-lg bg-zinc-900 p-1 text-sm font-semibold">
        {(["buy", "sell"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => switchMode(m)}
            className={`rounded-md py-1.5 ${mode === m ? "bg-white text-black" : "text-zinc-400"}`}
          >
            {m === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <input
            value={shown}
            onChange={(e) => {
              setPct(null);
              setAmount(e.target.value);
            }}
            placeholder={mode === "buy" ? `${isNative ? native : quote.symbol} to spend` : `${symbol} to sell`}
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
                    title={p === 100 && mode === "buy" && isNative ? `Keeps ${formatUnits(GAS_RESERVE, 18)} ${native} for gas` : undefined}
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] disabled:opacity-40 ${
                      pct === p ? "bg-white text-black" : "border border-white/15 text-zinc-400 hover:border-white hover:text-white"
                    }`}
                  >
                    {p === 100 ? "Max" : `${p}%`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {parsed > 0n && out > 0n && (
          <p className="text-sm text-zinc-400">
            ≈ {mode === "buy" ? `${fmtTokens(out)} ${symbol}` : `${fmtUnits(out, quote.decimals)} ${isNative ? native : quote.symbol}`}
            <span className={impactPct >= 5 ? " text-amber-300" : " text-zinc-600"}>
              {" "}
              · moves the price {impactPct < 0.01 ? "<0.01" : impactPct.toFixed(impactPct < 10 ? 2 : 0)}%
            </span>
            {charge && <span className="block text-xs text-zinc-600">{charge}</span>}
          </p>
        )}
        {parsed > 0n && out === 0n && !needsApproval && <p className="text-sm text-zinc-500">The pool cannot fill this.</p>}
        <button
          type="submit"
          disabled={!canTrade || isPending || isConfirming}
          className="w-full rounded-full bg-white py-2 text-sm font-semibold text-black disabled:opacity-50"
        >
          {!isConnected
            ? "Connect a wallet"
            : isPending
              ? "Sign in wallet…"
              : isConfirming
                ? lastAction === "approve"
                  ? "Approving…"
                  : "Confirming…"
                : needsBuyApproval
                  ? `Approve ${quote.symbol}`
                  : needsSellApproval
                    ? `Approve ${symbol}`
                    : mode === "buy"
                      ? "Buy in the pool"
                      : "Sell in the pool"}
        </button>
        {needsApproval && isConnected && !isPending && !isConfirming && (
          <p className="text-xs text-zinc-500">
            One-time approval: it lets the DEX router take the {needsBuyApproval ? quote.symbol : symbol} you swap, and only your own
            swaps can spend it.
          </p>
        )}
      </form>
      <SlippageControl bps={slippageBps} onChange={setSlippageBps} />
      {isSuccess && hash && (
        <p className="text-sm text-zinc-300">
          {lastAction === "approve" ? `Approved: press ${mode === "buy" ? "Buy" : "Sell"} to swap.` : "Done!"}{" "}
          <a href={`${explorer}/tx/${hash}`} target="_blank" className="underline">
            tx
          </a>
        </p>
      )}
      {error && <p className="text-sm text-zinc-400 break-all">{(error as { shortMessage?: string }).shortMessage ?? error.message}</p>}
    </div>
  );
}

const pctText = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** What the pool charges on one side, from the chain's figures: "0.5% launchpad
 *  fee + 1% buy tax, taken in coins"; null when there is nothing to tell. */
function rateLine(fees: FeeConfig, side: "buy" | "sell"): string | null {
  const tax = side === "buy" ? fees.buyTaxBps : fees.sellTaxBps;
  const parts = [fees.platformBps > 0 ? `${pctText(fees.platformBps)} launchpad fee` : null, tax > 0 ? sideFeeLabel(tax, side) : null].filter(Boolean);
  return parts.length ? `${parts.join(" + ")}, taken in coins` : null;
}

/** twenty minutes from now, as the router wants it */
function swapDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
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
