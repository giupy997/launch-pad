"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MEMO_MAX_BYTES, memoBytes } from "@/lib/litecoin/ledger";
import { buildTx, type BuiltTx, type Payment } from "@/lib/litecoin/tx";
import { LTC_NETWORK, api, fmtLtc, txLink, useFeeRate, useLtcWallet, useUtxos } from "@/lib/litecoin/client";
import { FundPanel, NeedsLtcWallet } from "./Wallet";

/** Litecoin has no "connect wallet" and no memo field in most wallets, so
 *  the site builds the transaction itself from the browser wallet's coins —
 *  the payments, the OP_RETURN instruction and the change — shows exactly
 *  what it is, and signs and broadcasts it on one click. */
export function SendPanel({
  payments,
  memo,
  title,
  note,
  confirmLabel = "Sign & broadcast",
  onSent,
}: {
  payments: Payment[];
  memo: string | null;
  title: string;
  note?: string;
  confirmLabel?: string;
  onSent?: (txid: string) => void;
}) {
  const { ready, secret, address } = useLtcWallet();
  const { utxos, isLoading, isError } = useUtxos(address);
  const { data: feeRate } = useFeeRate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const built = useMemo<{ tx?: BuiltTx; problem?: string }>(() => {
    if (!secret || !feeRate) return {};
    try {
      return { tx: buildTx({ network: LTC_NETWORK, secret, utxos, payments, memo, feeRate }) };
    } catch (e) {
      return { problem: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- payments is rebuilt every render; compare by value
  }, [secret, feeRate, utxos, memo, JSON.stringify(payments, (_, v) => (typeof v === "bigint" ? v.toString() : v))]);

  if (ready && !address) return <NeedsLtcWallet />;
  if (!address || !secret) return null;
  const bytes = memo ? memoBytes(memo) : 0;
  if (bytes > MEMO_MAX_BYTES) {
    return <p className="text-sm text-zinc-400">⚠ The instruction is {bytes} bytes — an OP_RETURN holds {MEMO_MAX_BYTES}. Shorten the name or the URL.</p>;
  }
  const total = payments.reduce((t, p) => t + p.lit, 0n);

  if (sent) {
    return (
      <div className="rounded-xl border border-white bg-black p-4 space-y-2">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{title} · broadcast ✓</div>
        <a href={txLink(sent)} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs text-zinc-300 underline">
          {sent}
        </a>
        <p className="text-[11px] text-zinc-500">
          It is folded into the ledger after 2 confirmations (~5 minutes). You can send the next instruction right away.
        </p>
        <button type="button" onClick={() => setSent(null)} className="text-xs text-zinc-500 underline">
          Send another
        </button>
      </div>
    );
  }

  async function submit() {
    if (!built.tx) return;
    setBusy(true);
    setError(null);
    try {
      const txid = await api.broadcast(built.tx.hex);
      setSent(txid);
      onSent?.(txid);
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["ltc-utxos", address] }), 1_500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const short = built.problem?.startsWith("insufficient") || built.problem?.includes("no coins");

  return (
    <div className="rounded-xl border border-zinc-700 bg-black p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{title}</span>
        <span className="font-mono text-sm text-white">{fmtLtc(total, 8)} LTC</span>
      </div>
      <div className="divide-y divide-zinc-900 font-mono text-xs">
        {payments.map((p, i) => (
          <Row key={i} k={i === 0 ? "To the desk" : `Output ${i}`} v={`${fmtLtc(p.lit, 8)} LTC → ${p.address.slice(0, 12)}…`} />
        ))}
        {memo && <Row k={`Memo · ${bytes}/${MEMO_MAX_BYTES} bytes`} v={memo} wrap />}
        <Row k="Network fee" v={built.tx ? `${fmtLtc(built.tx.fee, 8)} LTC · ${built.tx.vsize} vB @ ${feeRate} lit/vB` : feeRate ? "—" : "fetching…"} />
        <Row k="From" v={address} wrap />
      </div>
      {isLoading && utxos.length === 0 && <p className="text-xs text-zinc-500">Looking up your coins…</p>}
      {isError && <p className="text-xs text-zinc-400">⚠ The explorer is not answering — coins cannot be looked up right now.</p>}
      {built.problem && !short && <p className="text-xs text-zinc-400">⚠ {built.problem}</p>}
      {short && (
        <>
          <p className="text-xs text-zinc-400">⚠ {built.problem}</p>
          <FundPanel address={address} compact />
        </>
      )}
      {error && <p className="text-xs text-zinc-400">⚠ {error}</p>}
      <button
        type="button"
        disabled={!built.tx || busy}
        onClick={submit}
        className="w-full rounded-full bg-white py-2 text-sm font-semibold text-black hover:bg-zinc-200 disabled:opacity-40"
      >
        {busy ? "Broadcasting…" : confirmLabel}
      </button>
      <p className="text-[11px] text-zinc-600">
        {note ?? "Signed in this browser with your wallet key; nothing but the signed transaction leaves it."} Folded into the
        ledger after 2 confirmations (~5 min).
      </p>
    </div>
  );
}

function Row({ k, v, wrap }: { k: string; v: string; wrap?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-1.5">
      <span className="text-zinc-500 shrink-0">{k}</span>
      <span className={`text-zinc-300 text-right ${wrap ? "break-all" : "truncate"}`}>{v}</span>
    </div>
  );
}
