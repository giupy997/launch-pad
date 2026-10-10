"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { maxUint256, parseUnits } from "viem";
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchpadV11Abi, launchTokenAbi } from "@/lib/abi";
import type { LegacyPad } from "@/lib/config";
import { quoteSell, type FeeConfig } from "@/lib/curve";
import { fmtTokens, fmtUnits } from "@/lib/format";
import { useAppChain, useExplorer, type CurveInfo } from "@/lib/hooks";
import { refreshAfterTrade } from "@/components/TradeBox";

/** the slippage a legacy sell tolerates: 1%, no control to set it */
const SLIPPAGE_BPS = 100n;

/** The sell box of a coin still on its curve on a legacy pad: TradeBox's
 *  sell path, trimmed, against that pad and its ABI. The coin is not
 *  transferable before graduation, so the pad's sell is the only way out of
 *  it. The quote is the pad's own arithmetic (quoteSell) at the pad's rate
 *  and the coin's tax; the pad is approved once, unlimited, when the
 *  allowance is short, as on the live pad. */
export function LegacySell({
  pad,
  token,
  symbol,
  curve,
  fees,
  platformFeeBps,
  quote,
  balance,
}: {
  pad: LegacyPad;
  token: `0x${string}`;
  symbol: string;
  curve: CurveInfo;
  fees: FeeConfig;
  platformFeeBps: bigint;
  quote: { symbol: string; decimals: number };
  balance: bigint;
}) {
  const chainId = useAppChain().id;
  const explorer = useExplorer();
  const { address: user } = useAccount();
  const [amount, setAmount] = useState("");
  const parsed = safeParse(amount);
  const sellQuote = parsed > 0n ? quoteSell(curve, parsed, platformFeeBps, fees) : undefined;
  const minOut = sellQuote !== undefined ? sellQuote - (sellQuote * SLIPPAGE_BPS) / 10_000n : 0n;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: token,
    abi: launchTokenAbi,
    functionName: "allowance",
    args: user ? [user, pad.address] : undefined,
    chainId,
    query: { enabled: !!user, refetchInterval: 5_000 },
  });
  const needsApproval = parsed > 0n && (allowance === undefined || (allowance as bigint) < parsed);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const queryClient = useQueryClient();

  // a confirmed approval refreshes the allowance at once, so the button turns
  // into Sell; a confirmed sell refreshes what the page reads and clears the field
  const [lastAction, setLastAction] = useState<"approve" | "sell">("sell");
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!isSuccess || !hash || handled.current === hash) return;
    handled.current = hash;
    if (lastAction === "approve") refetchAllowance();
    else {
      setAmount("");
      refreshAfterTrade(queryClient);
    }
  }, [isSuccess, hash, lastAction, refetchAllowance, queryClient]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    reset();
    setLastAction(needsApproval ? "approve" : "sell");
    if (needsApproval) {
      writeContract({ address: token, abi: launchTokenAbi, functionName: "approve", chainId, args: [pad.address, maxUint256] });
    } else {
      writeContract({ address: pad.address, abi: launchpadV11Abi, functionName: "sell", chainId, args: [token, parsed, minOut] });
    }
  }

  const tooMuch = parsed > balance;
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="label">Sell on the curve</div>
      <div className="flex gap-2">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={`${symbol} to sell`}
          type="number"
          step="any"
          min="0"
          className="min-w-0 flex-1 rounded-lg input px-3 py-2 text-sm focus:border-white outline-none"
        />
        <button
          type="button"
          onClick={() => setAmount(balance > 0n ? fmtInput(balance) : "")}
          className="rounded-full border border-white/15 px-2.5 text-xs font-mono text-zinc-400 hover:border-white hover:text-white"
        >
          Max
        </button>
      </div>
      {sellQuote !== undefined && !tooMuch && (
        <p className="text-sm text-zinc-400">
          ≈ {fmtUnits(sellQuote, quote.decimals)} {quote.symbol}
          <span className="text-zinc-600"> · at least {fmtUnits(minOut, quote.decimals)} (1% slippage)</span>
        </p>
      )}
      {tooMuch && <p className="text-xs text-zinc-500">More than the {fmtTokens(balance)} {symbol} this wallet holds.</p>}
      <button
        type="submit"
        disabled={parsed === 0n || tooMuch || isPending || isConfirming}
        className="w-full rounded-lg bg-zinc-300 py-2 text-sm font-semibold text-black hover:bg-white disabled:opacity-40"
      >
        {isPending ? "Sign in wallet…" : isConfirming ? (lastAction === "approve" ? "Approving…" : "Confirming…") : needsApproval ? `Approve ${symbol}` : "Sell"}
      </button>
      {needsApproval && !isPending && !isConfirming && (
        <p className="text-xs text-zinc-500">One-time approval: it lets this launchpad take the {symbol} you sell, and only your own sells can spend it.</p>
      )}
      {isSuccess && hash && (
        <p className="text-sm text-zinc-300">
          {lastAction === "approve" ? "Approved: press Sell to trade." : "Done!"}{" "}
          <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer" className="underline">
            tx
          </a>
        </p>
      )}
      {error && <p className="text-sm text-zinc-400 break-all">{(error as { shortMessage?: string }).shortMessage ?? error.message}</p>}
    </form>
  );
}

function safeParse(v: string): bigint {
  try {
    return v ? parseUnits(v, 18) : 0n;
  } catch {
    return 0n;
  }
}

/** a whole balance as the field takes it: every decimal, so Max sells all of it */
function fmtInput(wei: bigint): string {
  const s = wei.toString().padStart(19, "0");
  const int = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
