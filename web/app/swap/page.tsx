"use client";

import { useEffect, useState } from "react";
import { parseEther } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { launchpadAbi, launchTokenAbi } from "@/lib/abi";
import {
  useLaunchpadAddress,
  useTokens,
  useExplorer,
  useAppChain,
  isQuoteAsset,
  ZERO_ADDRESS,
} from "@/lib/hooks";
import { fmtEth, fmtTokens } from "@/lib/format";
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
  const explorer = useExplorer();
  const appChainId = useAppChain().id;
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

  const { data: allowance } = useReadContract({
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

  // leg 1 quote: from -> ETH (if from is a token)
  const { data: sellQuote } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "quoteSell",
    args: from !== ETH ? [from, parsed] : undefined,
    query: { enabled: from !== ETH && parsed > 0n, refetchInterval: 5_000 },
  });

  // ETH input for the buy leg
  const ethIn = from === ETH ? parsed : ((sellQuote as bigint | undefined) ?? 0n);

  // leg 2 quote: ETH -> to (if to is a token)
  const { data: buyQuote } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "quoteBuy",
    args: to !== ETH ? [to, ethIn] : undefined,
    query: { enabled: to !== ETH && ethIn > 0n, refetchInterval: 5_000 },
  });

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const needsApproval =
    from !== ETH && parsed > 0n && (allowance === undefined || (allowance as bigint) < parsed);

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
        args: [pad, parsed],
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
      <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase text-center py-2">
        Swap
      </h1>

      <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-black p-5 space-y-3">
        <div className="space-y-1">
          <label className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
            From
          </label>
          <div className="flex gap-2">
            <TokenPicker value={from} onChange={(v) => setFrom(v)} tokens={live} />
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              type="number"
              step="any"
              min="0"
              className="flex-1 rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none text-right"
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
            className="rounded-full border border-zinc-700 w-8 h-8 text-zinc-400 hover:border-white hover:text-white"
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
            <div className="flex-1 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-right text-zinc-300">
              {invalid || parsed === 0n || outQuote === undefined
                ? "—"
                : to === ETH
                  ? `${fmtEth(outQuote)} ETH`
                  : `${fmtTokens(outQuote)} ${toToken?.symbol ?? ""}`}
            </div>
          </div>
        </div>

        {isTokenToToken && (
          <p className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 text-center">
            Route: {fromToken?.symbol} → ETH → {toToken?.symbol} · 2 transactions
          </p>
        )}

        <button
          type="submit"
          disabled={!deployed || !isConnected || invalid || parsed === 0n || busy}
          className="w-full rounded-full bg-white py-2.5 font-semibold text-black hover:bg-zinc-200 disabled:opacity-40"
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
                      ? "Confirming…"
                      : needsApproval
                        ? `Approve ${fromToken?.symbol}`
                        : "Swap"}
        </button>

        <div className="flex justify-center">
          <SlippageControl bps={slippageBps} onChange={setSlippageBps} />
        </div>
        <p className="text-xs text-zinc-600 text-center">1% curve fee per leg</p>

        {isSuccess && hash && step === "idle" && (
          <p className="text-sm text-zinc-300 text-center">
            Done!{" "}
            <a href={`${explorer}/tx/${hash}`} target="_blank" className="underline">
              tx
            </a>
          </p>
        )}
        {error && (
          <p className="text-sm text-zinc-400 break-all border border-zinc-700 rounded-lg p-2">
            ⚠ {(error as { shortMessage?: string }).shortMessage ?? error.message}
          </p>
        )}
      </form>

      {live.length === 0 && (
        <p className="text-center text-sm text-zinc-500">
          No live ETH-paired tokens on the curve to swap yet. Asset-paired
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
