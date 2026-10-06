"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useConnect, useConnections, useDisconnect, useSwitchChain } from "wagmi";
import { useAppChain, useExplorer } from "@/lib/hooks";
import { mysticName } from "@/lib/names";

/** one solid panel for whatever drops from the header: opaque, above everything */
const MENU =
  "absolute right-0 top-full mt-2 w-80 rounded-2xl border border-white/[0.12] bg-[rgb(var(--ink))] p-1.5 z-50 shadow-2xl shadow-black/80 fade-up";

export function ConnectButton() {
  const { address, isConnected, chainId, status } = useAccount();
  const appChain = useAppChain();
  const explorer = useExplorer();
  const { connect, connectors, isPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const connections = useConnections();
  const { switchChain, isPending: switching } = useSwitchChain();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // a click outside or Escape closes the menu
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Disconnect EVERY active connection: with several wallet extensions
  // installed (EIP-6963) more than one connector can be live, and killing
  // only the current one leaves the UI stuck on "connected". Then every read
  // is asked again, so nothing of the old wallet's stays on screen and a new
  // wallet starts clean, with no hard refresh. `reopen` offers the pick of
  // wallets right away (Switch wallet).
  async function disconnectAll(reopen = false) {
    setOpen(false);
    for (const c of connections) {
      try {
        await disconnectAsync({ connector: c.connector });
      } catch {
        /* keep going — disconnect the rest anyway */
      }
    }
    void queryClient.invalidateQueries();
    if (reopen) setOpen(true);
  }

  // the cookie says a wallet was connected and the extension has not answered yet
  if (status === "reconnecting") {
    return (
      <button disabled className="btn-ghost px-4 sm:px-5 py-2 text-sm opacity-70 whitespace-nowrap">
        Reconnecting…
      </button>
    );
  }

  if (!isConnected) {
    // The generic injected connector stands in for whatever extension is
    // installed; once EIP-6963 has named them, it only duplicates the list.
    const named = connectors.some((c) => c.type === "injected" && c.id !== "injected");
    const choices = connectors.filter((c) => !(named && c.id === "injected"));
    const pick = (c: (typeof connectors)[number]) => {
      setOpen(false);
      connect({ connector: c, chainId: appChain.id });
    };
    return (
      <div ref={ref} className="relative">
        <button
          onClick={() => (choices.length === 1 ? pick(choices[0]) : setOpen((o) => !o))}
          disabled={isPending || choices.length === 0}
          className="btn-primary px-4 sm:px-5 py-2 text-sm disabled:opacity-50 whitespace-nowrap"
        >
          {isPending ? (
            "Connecting…"
          ) : (
            <>
              Connect<span className="hidden sm:inline"> wallet</span>
            </>
          )}
        </button>
        {open && choices.length > 1 && (
          <div className={MENU}>
            <div className="px-3 pt-2 pb-1 font-mono text-[10px] tracking-widest uppercase text-zinc-500">Choose a wallet</div>
            {choices.map((c) => (
              <MenuItem key={c.uid} onClick={() => pick(c)}>
                <span className="flex items-center gap-2.5">
                  {c.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.icon} alt="" className="h-4 w-4 rounded" />
                  ) : (
                    <span className="h-4 w-4 rounded-full border border-white/30" />
                  )}
                  <span>{c.id === "injected" ? "Browser wallet" : c.name}</span>
                  {c.type === "walletConnect" && <span className="ml-auto text-[10px] text-zinc-500">mobile · QR</span>}
                </span>
              </MenuItem>
            ))}
          </div>
        )}
      </div>
    );
  }

  const wrongNetwork = chainId !== appChain.id;
  const wallet = connections.find((c) => c.accounts.some((a) => a.toLowerCase() === address?.toLowerCase()))?.connector.name;

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
        title={address}
        aria-expanded={open}
        className="rounded-full border border-white/15 px-3 sm:px-4 py-2 text-sm font-medium text-zinc-200 transition-colors duration-150 hover:border-white hover:text-white whitespace-nowrap"
      >
        {address ? mysticName(address) : ""}
      </button>

      {open && address && (
        <div className={MENU}>
          <div className="px-3 pt-2 pb-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold text-white">{mysticName(address)}</span>
              {wallet && <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{wallet}</span>}
            </div>
            <div className="mt-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] leading-5 text-zinc-300 break-all select-all">
              {address}
            </div>
          </div>
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
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-zinc-300 hover:bg-white/[0.06] hover:text-white"
            onClick={() => setOpen(false)}
          >
            View on explorer ↗
          </a>
          <MenuItem onClick={() => void disconnectAll(true)}>Switch wallet</MenuItem>
          <MenuItem onClick={() => void disconnectAll()} danger>
            Disconnect
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-white/[0.06] ${
        danger ? "text-white font-semibold" : "text-zinc-300 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
