"use client";

import { useEffect, useRef, useState } from "react";
import { type TokenInfo, useNativeSymbol } from "@/lib/hooks";
import { TokenLogo } from "@/components/TokenLogo";
import { shortAddr } from "@/lib/format";

export type PickerValue = "ETH" | `0x${string}`;

/** Searchable asset picker: type a ticker/name or paste a contract address. */
export function TokenPicker({
  value,
  onChange,
  tokens,
}: {
  value: PickerValue;
  onChange: (v: PickerValue) => void;
  tokens: TokenInfo[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const query = q.trim().toLowerCase();
  const isAddr = /^0x[0-9a-f]{40}$/.test(query);
  const filtered = tokens.filter((t) => {
    if (!query) return true;
    if (isAddr) return t.address.toLowerCase() === query;
    return (
      t.symbol.toLowerCase().includes(query) ||
      t.name.toLowerCase().includes(query) ||
      t.address.toLowerCase().startsWith(query)
    );
  });
  const native = useNativeSymbol();
  const showEth = !query || "eth".includes(query) || native.toLowerCase().includes(query);
  const selected = value !== "ETH" ? tokens.find((t) => t.address === value) : undefined;

  function pick(v: PickerValue) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full bg-black border border-zinc-700 px-3 py-2 text-sm text-white hover:border-white"
      >
        {value === "ETH" ? (
          <span className="font-semibold">{native}</span>
        ) : (
          <>
            <TokenLogo uri={selected?.meta.logoURI ?? ""} symbol={selected?.symbol ?? "?"} size={18} />
            <span className="font-semibold">{selected?.symbol ?? shortAddr(value)}</span>
          </>
        )}
        <svg width="9" height="9" viewBox="0 0 10 10" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 mt-2 w-72 rounded-xl border border-zinc-700 bg-black p-2 z-20 shadow-lg shadow-black/60">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search or paste contract address"
            className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none placeholder:text-zinc-600 mb-1"
          />
          <div className="max-h-56 overflow-y-auto">
            {showEth && (
              <Row onClick={() => pick("ETH")} active={value === "ETH"}>
                <span className="w-[18px] text-center font-mono text-xs">Ξ</span>
                <span className="flex-1 font-semibold">{native}</span>
                <span className="text-xs text-zinc-500">native</span>
              </Row>
            )}
            {filtered.map((t) => (
              <Row key={t.address} onClick={() => pick(t.address)} active={value === t.address}>
                <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={18} />
                <span className="flex-1 min-w-0">
                  <span className="font-semibold">{t.symbol}</span>{" "}
                  <span className="text-zinc-500 text-xs truncate">{t.name}</span>
                </span>
                <span className="font-mono text-[10px] text-zinc-600">{shortAddr(t.address)}</span>
              </Row>
            ))}
            {!showEth && filtered.length === 0 && (
              <p className="px-3 py-4 text-sm text-zinc-600">
                {isAddr ? "No curve token with this address on this chain." : "No match."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm ${
        active ? "bg-zinc-900 text-white" : "text-zinc-300 hover:bg-zinc-900 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
