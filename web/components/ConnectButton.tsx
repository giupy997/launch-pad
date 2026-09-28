"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useConnections, useDisconnect, useSwitchChain } from "wagmi";
import { useAppChain, useExplorer } from "@/lib/hooks";

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const appChain = useAppChain();
  const explorer = useExplorer();
  const { connect, connectors, isPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const connections = useConnections();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // Disconnect EVERY active connection: with several wallet extensions
  // installed (EIP-6963) more than one connector can be live, and killing
  // only the current one leaves the UI stuck on "connected".
  async function disconnectAll() {
    setOpen(false);
    for (const c of connections) {
      try {
        await disconnectAsync({ connector: c.connector });
      } catch {
        /* keep going — disconnect the rest anyway */
      }
    }
  }

  if (!isConnected) {
    return (
      <button
        onClick={() => connect({ connector: connectors[0] })}
        disabled={isPending || connectors.length === 0}
        className="btn-primary px-4 sm:px-5 py-2 text-sm disabled:opacity-50 whitespace-nowrap"
      >
        {isPending ? "Connecting…" : (
          <>
            Connect<span className="hidden sm:inline"> wallet</span>
          </>
        )}
      </button>
    );
  }

  const wrongNetwork = chainId !== appChain.id;

  return (
    <div ref={ref} className="relative flex items-center gap-1.5">
      {wrongNetwork && (
        <button
          onClick={() => switchChain({ chainId: appChain.id })}
          disabled={switching}
          title={`Wallet is on another network — switch to ${appChain.name}`}
          className="rounded-full border border-white w-8 h-8 text-xs font-bold text-white hover:bg-white hover:text-black disabled:opacity-50"
        >
          !
        </button>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full border border-white/15 px-3 sm:px-4 py-2 text-sm font-mono text-zinc-300 hover:border-white hover:text-white"
      >
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </button>

      {open && address && (
        <div className="absolute right-0 top-full mt-2 w-56 rounded-xl input p-1.5 z-30 shadow-lg shadow-black/60">
          <MenuItem
            onClick={() => {
              navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied ✓" : "Copy address"}
          </MenuItem>
          <a
            href={`${explorer}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-900 hover:text-white"
            onClick={() => setOpen(false)}
          >
            View on explorer ↗
          </a>
          <MenuItem onClick={disconnectAll} danger>
            Disconnect
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-zinc-900 ${
        danger ? "text-white font-semibold" : "text-zinc-300 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
