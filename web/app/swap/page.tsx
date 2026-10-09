"use client";

import { useEffect, useState } from "react";
import { maxUint256, parseEther } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { launchpadAbi, launchTokenAbi } from "@/lib/abi";
import {
  useLaunchpadAddress,
  usePadAbi,
  useTokens,
  useExplorer,
  useAppChain,
  useNativeSymbol,
  isQuoteAsset,
  ZERO_ADDRESS,
} from "@/lib/hooks";
import { fmtEth, fmtTokens } from "@/lib/format";
import { quoteBuy, quoteSell, parseFeeConfig, NO_TAX } from "@/lib/curve";
import { NotDeployedNotice } from "@/components/NotDeployedNotice";
import { SlippageControl, useSlippageBps } from "@/components/SlippageControl";
import { TokenPicker } from "@/components/TokenPicker";

const ETH = "ETH" as const;
type Side = typeof ETH | `0x${string}`;
type Step = "idle" | "selling" | "buying";

export default function SwapPage() {
  const padMaybe = useLaunchpadAddress();
  const deployed = !!padMaybe;
  const pad = padMaybe ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);
  const padAbi = usePadAbi(); // feeConfig answers six fields on v11, seven on v12: read with the pad's own ABI
  const explorer = useExplorer();
  const appChainId = useAppChain().id;
  const native = useNativeSymbol();
  const { address: user, isConnected } = useAccount();
  const { tokens } = useTokens();
  const live = tokens.filter(
    (t) =>
      !t.curve.graduated &&
      t.curve.quoteAsset === ZERO_ADDRESS &&
      !t.isPreMarket &&
      !isQuoteAsset(appChainId, t.address) // pre-markets are pair assets, not swap targets
  );

  const [from, setFrom] = useState<Side>(ETH);
  const [to, setTo] = useState<Side>(ETH);
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [slippageBps, setSlippageBps] = useSlippageBps();

  // default "to" once tokens load
  useEffect(() => {
    if (to === ETH && from === ETH && live.length > 0) setTo(live[0].address);
  }, [live, from, to]);

  const parsed = safeParse(amount);
  const fromToken = from !== ETH ? live.find((t) => t.address === from) : undefined;
  const toToken = to !== ETH ? live.find((t) => t.address === to) : undefined;
  const isTokenToToken = from !== ETH && to !== ETH;

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: from !== ETH ? from : undefined,
    abi: launchTokenAbi,
    functionName: "allowance",
    args: user && from !== ETH ? [user, pad] : undefined,
    query: { enabled: !!user && from !== ETH, refetchInterval: 5_000 },
  });

  const { data: fromBalance } = useReadContract({
    address: from !== ETH ? from : undefined,
    abi: launchTokenAbi,
    functionName: "balanceOf",
    args: user && from !== ETH ? [user] : undefined,
    query: { enabled: !!user && from !== ETH, refetchInterval: 5_000 },
  });

  // the pad's fee, and each coin's own: the quotes are the curve's arithmetic, run here
  const { data: feeBpsRaw } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "feeBps",
    query: { enabled: deployed, staleTime: 60_000 },
  });
  const platformFeeBps = (feeBpsRaw as bigint | undefined) ?? 100n;
  const { data: fromFeesRaw } = useReadContract({
    address: pad,
    abi: padAbi,
    functionName: "feeConfig",
    args: from !== ETH ? [from] : undefined,
    query: { enabled: from !== ETH, staleTime: Infinity },
  });
  const { data: toFeesRaw } = useReadContract({
    address: pad,
    abi: padAbi,
    functionName: "feeConfig",
    args: to !== ETH ? [to] : undefined,
    query: { enabled: to !== ETH, staleTime: Infinity },
  });

  // leg 1 quote: from -> ETH (if from is a token)
  const sellQuote: bigint | undefined =
    fromToken && parsed > 0n
      ? quoteSell(fromToken.curve, parsed, platformFeeBps, fromFeesRaw ? parseFeeConfig(fromFeesRaw, Number(platformFeeBps)) : NO_TAX)
      : undefined;

  // ETH input for the buy leg
  const ethIn = from === ETH ? parsed : (sellQuote ?? 0n);

  // leg 2 quote: ETH -> to (if to is a token)
  const buyQuote: bigint | undefined =
    toToken && ethIn > 0n
      ? quoteBuy(toToken.curve, ethIn, platformFeeBps, toFeesRaw ? parseFeeConfig(toFeesRaw, Number(platformFeeBps)) : NO_TAX)
      : undefined;

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  // one unlimited approval per coin (the pad only pulls from msg.sender), so
  // no Approve before every swap; refreshed as soon as it confirms
  const needsApproval =
    from !== ETH && parsed > 0n && (allowance === undefined || (allowance as bigint) < parsed);
  const [lastAction, setLastAction] = useState<"approve" | "trade">("trade");
  useEffect(() => {
    if (isSuccess && lastAction === "approve") refetchAllowance();
  }, [isSuccess, lastAction, refetchAllowance]);

  // token->token: after the sell leg confirms, fire the buy leg
  useEffect(() => {
    if (step === "selling" && isSuccess && to !== ETH && ethIn > 0n) {
      setStep("buying");
      reset();
      writeContract({
        address: pad,
        abi: launchpadAbi,
        functionName: "buy",
        chainId: appChainId,
        args: [to, minOut((buyQuote as bigint | undefined) ?? 0n)],
        value: ethIn,
      });
    }
  }, [step, isSuccess, to, ethIn, buyQuote, pad, appChainId, reset, writeContract]);

  useEffect(() => {
    if (step === "buying" && isSuccess) setStep("idle");
  }, [step, isSuccess]);

  function minOut(quote: bigint): bigint {
    return quote - (quote * BigInt(slippageBps)) / 10_000n;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    reset();
    setLastAction(from !== ETH && needsApproval ? "approve" : "trade");
    if (from === ETH && to !== ETH) {
      writeContract({
        address: pad,
        abi: launchpadAbi,
        functionName: "buy",
        chainId: appChainId,
        args: [to, minOut((buyQuote as bigint | undefined) ?? 0n)],
        value: parsed,
      });
    } else if (from !== ETH && needsApproval) {
      writeContract({
        address: from,
        abi: launchTokenAbi,
        functionName: "approve",
        chainId: appChainId,
        args: [pad, maxUint256],
      });
    } else if (from !== ETH) {
      if (to !== ETH) setStep("selling");
      writeContract({
        address: pad,
        abi: launchpadAbi,
        functionName: "sell",
        chainId: appChainId,
        args: [from, parsed, minOut((sellQuote as bigint | undefined) ?? 0n)],
      });
    }
  }

  function flip() {
    const f = from;
    setFrom(to);
    setTo(f);
    setAmount("");
  }

  const invalid = from === to || (from === ETH && to === ETH);
  const outQuote =
    to === ETH ? (sellQuote as bigint | undefined) : (buyQuote as bigint | undefined);
  const busy = isPending || isConfirming || step !== "idle";

  return (
    <div className="max-w-md mx-auto space-y-6">
      <NotDeployedNotice />
      <h1 className="display text-4xl text-white text-center py-2">
        Swap
      </h1>

      <form onSubmit={submit} className="card p-5 space-y-3">
        <div className="space-y-1">
          <label className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
            From
          </label>
          <div className="flex gap-2">
            <TokenPicker
              value={from}
              onChange={(v) => {
                setFrom(v);
                setAmount("");
              }}
              tokens={live}
            />
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              type="number"
              step="any"
              min="0"
              className="flex-1 rounded-lg input px-3 py-2 text-sm focus:border-white outline-none text-right"
            />
          </div>
          {from !== ETH && fromBalance !== undefined && (
            <button
              type="button"
              onClick={() => setAmount(fmtRaw(fromBalance as bigint))}
              className="text-xs text-zinc-500 underline"
            >
              Max: {fmtTokens(fromBalance as bigint)} {fromToken?.symbol}
            </button>
          )}
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={flip}
            className="rounded-full border border-white/15 w-8 h-8 text-zinc-400 hover:border-white hover:text-white"
            title="Flip"
          >
            <span className="font-mono">↑↓</span>
          </button>
        </div>

        <div className="space-y-1">
          <label className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
            To
          </label>
          <div className="flex gap-2 items-center">
            <TokenPicker value={to} onChange={(v) => setTo(v)} tokens={live} />
            <div className="flex-1 rounded-lg border border-white/10 px-3 py-2 text-sm text-right text-zinc-300">
              {invalid || parsed === 0n || outQuote === undefined
                ? "—"
                : to === ETH
                  ? `${fmtEth(outQuote)} ${native}`
                  : `${fmtTokens(outQuote)} ${toToken?.symbol ?? ""}`}
            </div>
          </div>
        </div>

        {isTokenToToken && (
          <p className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 text-center">
            Route: {fromToken?.symbol} → {native} → {toToken?.symbol} · 2 transactions
          </p>
        )}

        <button
          type="submit"
          disabled={!deployed || !isConnected || invalid || parsed === 0n || busy}
          className="w-full rounded-full bg-white py-2.5 font-semibold text-black hover:bg-zinc-100 transition-colors disabled:opacity-40"
        >
          {!deployed
            ? "Not deployed on this chain"
            : !isConnected
            ? "Connect wallet"
            : invalid
              ? "Select two different assets"
              : step === "selling"
                ? "Step 1/2: selling…"
                : step === "buying"
                  ? "Step 2/2: buying…"
                  : isPending
                    ? "Sign in wallet…"
                    : isConfirming
                      ? lastAction === "approve"
                        ? "Approving…"
                        : "Confirming…"
                      : needsApproval
                        ? `Approve ${fromToken?.symbol}`
                        : "Swap"}
        </button>

        <div className="flex justify-center">
          <SlippageControl bps={slippageBps} onChange={setSlippageBps} />
        </div>
        <p className="text-xs text-zinc-600 text-center">Each leg pays its curve&apos;s fee: the platform fee and the coin&apos;s own tax, if any</p>

        {isSuccess && hash && step === "idle" && (
          <p className="text-sm text-zinc-300 text-center">
            {lastAction === "approve" ? "Approved: press Swap to trade." : "Done!"}{" "}
            <a href={`${explorer}/tx/${hash}`} target="_blank" className="underline">
              tx
            </a>
          </p>
        )}
        {error && (
          <p className="text-sm text-zinc-400 break-all border border-white/15 rounded-lg p-2">
            ⚠ {(error as { shortMessage?: string }).shortMessage ?? error.message}
          </p>
        )}
      </form>

      {live.length === 0 && (
        <p className="text-center text-sm text-zinc-500">
          No live {native}-paired tokens on the curve to swap yet. Asset-paired
          coins trade from their token page.
        </p>
      )}

    </div>
  );
}

function safeParse(v: string): bigint {
  try {
    return v ? parseEther(v) : 0n;
  } catch {
    return 0n;
  }
}

function fmtRaw(wei: bigint): string {
  const s = wei.toString().padStart(19, "0");
  const int = s.slice(0, -18);
  const frac = s.slice(-18).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}
