"use client";

import { useState } from "react";
import { parseEther } from "viem";
import {
  useAccount,
  useBalance,
  useSendTransaction,
  useSwitchChain,
  useWaitForTransactionReceipt,
} from "wagmi";
import { giwaSepolia, robinhood, litvmTestnet, sepolia, mainnet, L1_STANDARD_BRIDGE } from "@/lib/config";
import { useAppChain } from "@/lib/hooks";
import { fmtEth } from "@/lib/format";

export default function BridgePage() {
  const chain = useAppChain();
  if (chain.id === litvmTestnet.id) return <LitvmBridge />;
  return chain.id === robinhood.id ? <RobinhoodBridge /> : <GiwaBridge />;
}

/* --------------------------------------------------------------- LitVM */

function LitvmBridge() {
  const { address: user } = useAccount();
  const { data: bal } = useBalance({
    address: user,
    chainId: litvmTestnet.id,
    query: { enabled: !!user, refetchInterval: 15_000 },
  });

  return (
    <div className="max-w-md mx-auto space-y-6">
      <Header />
      <p className="text-sm text-zinc-400 text-center">
        LitVM is Litecoin&apos;s EVM layer 2. Its gas coin, zkLTC, is LTC locked on the Litecoin base
        layer and released 1:1 on LitVM through the official bridge. On the Liteforge testnet, zkLTC
        comes free from the faucet.
      </p>

      <div className="grid grid-cols-1 gap-3">
        <Balance label="LitVM Liteforge" value={bal?.value} symbol="zkLTC" />
      </div>

      <a
        href="https://testnet.litvm.com"
        target="_blank"
        rel="noopener noreferrer"
        className="block w-full rounded-full bg-white py-2.5 font-semibold text-black hover:bg-zinc-200 text-center"
      >
        Open the LitVM testnet portal (faucet &amp; bridge) ↗
      </a>

      <div className="rounded-xl border border-zinc-800 p-5 space-y-2">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">How it works</div>
        <ul className="text-sm text-zinc-400 space-y-1.5 list-disc list-inside">
          <li>Add LitVM to your wallet: chain ID 4441, RPC liteforge.rpc.caldera.xyz, symbol zkLTC.</li>
          <li>Testnet: request zkLTC from the faucet, then launch and trade here.</li>
          <li>Mainnet (expected later in 2026): lock LTC on Litecoin, receive zkLTC through the bridge.</li>
        </ul>
      </div>

      <p className="text-xs text-zinc-600 text-center">
        Use only the official LitVM sites — see the{" "}
        <a href="https://docs.litvm.com" target="_blank" className="underline hover:text-zinc-400">
          LitVM docs
        </a>
        .
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- GIWA */

function GiwaBridge() {
  const { address: user, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const [amount, setAmount] = useState("");

  const { data: l1Bal } = useBalance({
    address: user,
    chainId: sepolia.id,
    query: { enabled: !!user, refetchInterval: 10_000 },
  });
  const { data: l2Bal } = useBalance({
    address: user,
    chainId: giwaSepolia.id,
    query: { enabled: !!user, refetchInterval: 10_000 },
  });

  const { sendTransaction, data: hash, isPending, error, reset } = useSendTransaction();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
    chainId: sepolia.id,
  });

  const parsed = safeParse(amount);
  const onL1 = chainId === sepolia.id;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    reset();
    // Plain ETH transfer to the L1StandardBridge bridges to the same
    // address on GIWA L2 (OP Stack receive() -> bridgeETH).
    sendTransaction({
      to: L1_STANDARD_BRIDGE,
      value: parsed,
      chainId: sepolia.id,
    });
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <Header />
      <p className="text-sm text-zinc-400 text-center">
        Move test ETH from Ethereum Sepolia to GIWA Sepolia through the official
        OP Stack Standard Bridge.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Balance label="Ethereum Sepolia" value={l1Bal?.value} />
        <Balance label="GIWA Sepolia" value={l2Bal?.value} />
      </div>

      <form onSubmit={submit} className="rounded-xl border border-zinc-800 bg-black p-5 space-y-3">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
          Deposit · Sepolia → GIWA
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="ETH amount"
          type="number"
          step="any"
          min="0"
          className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none"
        />

        {!onL1 && isConnected ? (
          <button
            type="button"
            onClick={() => switchChain({ chainId: sepolia.id })}
            className="w-full rounded-full border border-white py-2.5 font-semibold text-white hover:bg-white hover:text-black"
          >
            Switch to Ethereum Sepolia
          </button>
        ) : (
          <button
            type="submit"
            disabled={!isConnected || parsed === 0n || isPending || isConfirming}
            className="w-full rounded-full bg-white py-2.5 font-semibold text-black hover:bg-zinc-200 disabled:opacity-40"
          >
            {!isConnected
              ? "Connect wallet"
              : isPending
                ? "Sign in wallet…"
                : isConfirming
                  ? "Confirming on L1…"
                  : "Deposit"}
          </button>
        )}

        <p className="text-xs text-zinc-600">
          Funds arrive on GIWA in ~1–3 minutes after L1 confirmation.
        </p>

        {isSuccess && hash && (
          <p className="text-sm text-zinc-300">
            Deposit sent!{" "}
            <a
              href={`${sepolia.blockExplorers.default.url}/tx/${hash}`}
              target="_blank"
              className="underline"
            >
              L1 tx
            </a>{" "}
            — watch your GIWA balance above.
          </p>
        )}
        {error && (
          <p className="text-sm text-zinc-400 break-all border border-zinc-700 rounded-lg p-2">
            ⚠ {(error as { shortMessage?: string }).shortMessage ?? error.message}
          </p>
        )}
      </form>

      <div className="rounded-xl border border-zinc-800 p-5 space-y-2">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
          Withdraw · GIWA → Sepolia
        </div>
        <p className="text-sm text-zinc-400">
          Withdrawals use the OP Stack 7-day challenge period and a
          prove/finalize flow. Use the official tooling listed in the{" "}
          <a
            href="https://docs.giwa.io/tools/bridges"
            target="_blank"
            className="underline hover:text-white"
          >
            GIWA bridge docs
          </a>
          .
        </p>
      </div>

      <p className="text-xs text-zinc-600 text-center">
        Need L1 test ETH? Use any{" "}
        <a
          href="https://docs.giwa.io/get-started/faucets"
          target="_blank"
          className="underline hover:text-zinc-400"
        >
          Sepolia faucet
        </a>
        .
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ Robinhood */

function RobinhoodBridge() {
  const { address: user } = useAccount();

  const { data: l1Bal } = useBalance({
    address: user,
    chainId: mainnet.id,
    query: { enabled: !!user, refetchInterval: 15_000 },
  });
  const { data: l2Bal } = useBalance({
    address: user,
    chainId: robinhood.id,
    query: { enabled: !!user, refetchInterval: 15_000 },
  });

  return (
    <div className="max-w-md mx-auto space-y-6">
      <Header />
      <p className="text-sm text-zinc-400 text-center">
        Robinhood Chain is an Arbitrum Orbit rollup: deposits and withdrawals
        go through the official Arbitrum canonical bridge, with Ethereum as
        the source and Robinhood Chain as the destination.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Balance label="Ethereum" value={l1Bal?.value} />
        <Balance label="Robinhood Chain" value={l2Bal?.value} />
      </div>

      <a
        href="https://bridge.arbitrum.io"
        target="_blank"
        rel="noopener noreferrer"
        className="block w-full rounded-full bg-white py-2.5 font-semibold text-black hover:bg-zinc-200 text-center"
      >
        Open the Arbitrum canonical bridge ↗
      </a>

      <div className="rounded-xl border border-zinc-800 p-5 space-y-2">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
          How it works
        </div>
        <ul className="text-sm text-zinc-400 space-y-1.5 list-disc list-inside">
          <li>Deposits (Ethereum → Robinhood) confirm in ~10 minutes.</li>
          <li>Withdrawals follow the Arbitrum challenge period before finalizing.</li>
          <li>This is real ETH on mainnet — double-check every transaction.</li>
        </ul>
      </div>

      <p className="text-xs text-zinc-600 text-center">
        ⚠ Beware of fake &quot;Robinhood bridge&quot; sites. Use only the
        canonical bridge linked above — see the{" "}
        <a
          href="https://docs.robinhood.com/chain/bridging/"
          target="_blank"
          className="underline hover:text-zinc-400"
        >
          official bridging docs
        </a>
        .
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ shared */

function Header() {
  return (
    <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase text-center py-2">
      Bridge
    </h1>
  );
}

function Balance({ label, value, symbol = "ETH" }: { label: string; value?: bigint; symbol?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 p-4">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold">
        {value !== undefined ? `${fmtEth(value)} ${symbol}` : "—"}
      </div>
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
