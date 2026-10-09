"use client";

import { useState } from "react";
import { isAddress, zeroAddress } from "viem";
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { useAppChain, useLaunchpadAddress, type TokenMeta } from "@/lib/hooks";
import { shortAddr } from "@/lib/format";

const inputCls =
  "w-full rounded-lg input px-3 py-2 text-sm focus:border-white outline-none placeholder:text-zinc-600";

/** Creator-only controls on the token page: go live / stop the stream and
 *  redirect the creator fee share to another wallet (pump.fun-style). */
export function CreatorPanel({
  token,
  meta,
}: {
  token: `0x${string}`;
  meta: TokenMeta;
}) {
  const pad = useLaunchpadAddress();
  const appChainId = useAppChain().id;
  const { address: user } = useAccount();
  const [streamUrl, setStreamUrl] = useState(meta.livestream);
  const [recipient, setRecipient] = useState("");

  const { data: currentRecipient } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "feeRecipient",
    args: [token],
    query: { enabled: !!pad, refetchInterval: 10_000 },
  });

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  if (!pad || !user) return null;

  const busy = isPending || isConfirming;
  const live = meta.livestream.trim().length > 0;
  const redirected =
    currentRecipient !== undefined && (currentRecipient as string) !== zeroAddress;

  function setLivestream(url: string) {
    if (!pad) return;
    reset();
    writeContract({
      address: pad,
      abi: launchpadAbi,
      functionName: "updateMetadata",
      chainId: appChainId,
      args: [
        token,
        {
          logoURI: meta.logoURI,
          website: meta.website,
          twitter: meta.twitter,
          telegram: meta.telegram,
          livestream: url.trim(),
          description: meta.description,
        },
      ],
    });
  }

  function saveRecipient(addr: string) {
    if (!pad) return;
    reset();
    writeContract({
      address: pad,
      abi: launchpadAbi,
      functionName: "setFeeRecipient",
      chainId: appChainId,
      args: [token, addr as `0x${string}`],
    });
  }

  return (
    <div className="card p-5 space-y-5">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
        Creator controls
      </div>

      {/* livestream */}
      <div className="space-y-2">
        <div className="text-sm text-zinc-300">
          {live ? "You are live." : "Go live — paste your stream URL (YouTube / Twitch)."}
        </div>
        <div className="flex gap-2">
          <input
            value={streamUrl}
            onChange={(e) => setStreamUrl(e.target.value)}
            placeholder="https://youtube.com/live/…"
            type="url"
            className={inputCls}
          />
          <button
            onClick={() => setLivestream(streamUrl)}
            disabled={busy || !streamUrl.trim()}
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-zinc-100 transition-colors disabled:opacity-40 whitespace-nowrap"
          >
            {live ? "Update" : "Go live"}
          </button>
        </div>
        {live && (
          <button
            onClick={() => {
              setStreamUrl("");
              setLivestream("");
            }}
            disabled={busy}
            className="text-xs text-zinc-500 underline hover:text-white"
          >
            End stream
          </button>
        )}
      </div>

      {/* fee redirect */}
      <div className="space-y-2 border-t border-white/[0.06] pt-4">
        <div className="text-sm text-zinc-300">
          Fee recipient{" "}
          <span className="text-zinc-500">
            — your creator share currently accrues to{" "}
            {redirected ? shortAddr(currentRecipient as string) : "you"}
          </span>
        </div>
        <div className="flex gap-2">
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x… wallet to receive your fees"
            className={`${inputCls} font-mono`}
          />
          <button
            onClick={() => saveRecipient(recipient.trim())}
            disabled={busy || !isAddress(recipient.trim())}
            className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-zinc-100 transition-colors disabled:opacity-40"
          >
            Save
          </button>
        </div>
        {redirected && (
          <button
            onClick={() => saveRecipient(zeroAddress)}
            disabled={busy}
            className="text-xs text-zinc-500 underline hover:text-white"
          >
            Reset to my wallet
          </button>
        )}
      </div>

      {busy && <p className="text-xs text-zinc-500">Waiting for wallet / confirmation…</p>}
      {isSuccess && <p className="text-xs text-zinc-400">Saved ✓</p>}
      {error && (
        <p className="text-xs text-zinc-500 break-all">
          ⚠ {(error as { shortMessage?: string }).shortMessage ?? error.message}
        </p>
      )}
    </div>
  );
}
