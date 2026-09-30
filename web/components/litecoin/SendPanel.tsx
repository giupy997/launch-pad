"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MEMO_MAX_BYTES, memoBytes } from "@/lib/litecoin/ledger";
import { buildTx, buildUnsigned, finishSigned, type BuiltTx, type Payment, type UnsignedTx } from "@/lib/litecoin/tx";
import { LTC_NETWORK, api, extension, fmtLtc, noteSpend, txLink, useFeeRate, useLtcWallet, useUtxos } from "@/lib/litecoin/client";
import { FundPanel, NeedsLtcWallet } from "./Wallet";

/** Litecoin has no memo field in most wallets, so the site builds the
 *  transaction itself from the wallet's coins — the payments, the OP_RETURN
 *  instruction and the change — shows exactly what it is, and on one click
 *  signs it (the browser wallet) or hands it to the extension to sign, then
 *  broadcasts it. */
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
  const { ready, kind, secret, address, ext } = useLtcWallet();
  const { utxos, isLoading, isError } = useUtxos(address);
  const { data: feeRate } = useFeeRate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"" | "signing" | "broadcasting">("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pubkey = ext?.pubkey ?? null;
  // payments is rebuilt every render: compare it by value
  const paymentsKey = JSON.stringify(payments, (_, v) => (typeof v === "bigint" ? v.toString() : v));

  const built = useMemo<{ tx?: BuiltTx; unsigned?: UnsignedTx; problem?: string }>(() => {
    if (!feeRate || !address) return {};
    try {
      if (kind === "hot" && secret) return { tx: buildTx({ network: LTC_NETWORK, secret, utxos, payments, memo, feeRate }) };
      if (kind === "ext" && pubkey) return { unsigned: buildUnsigned({ network: LTC_NETWORK, address, pubkey, utxos, payments, memo, feeRate }) };
      return {};
    } catch (e) {
      return { problem: (e as Error).message };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- payments enters through paymentsKey
  }, [kind, secret, address, pubkey, feeRate, utxos, memo, paymentsKey]);

  if (ready && !address) return <NeedsLtcWallet />;
  if (!address) return null;
  const bytes = memo ? memoBytes(memo) : 0;
  if (bytes > MEMO_MAX_BYTES) {
    return <p className="text-sm text-zinc-400">⚠ The instruction is {bytes} bytes — an OP_RETURN holds {MEMO_MAX_BYTES}. Shorten the name or the URL.</p>;
  }
  const total = payments.reduce((t, p) => t + p.lit, 0n);
  /** What the transaction does, whoever signs it. */
  const plan = built.tx ?? built.unsigned;
  const signer = ext?.name ?? null;

  if (sent) {
    return (
      <div className="card border-white/40 p-4 space-y-2">
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
    if (!plan || !address) return;
    setError(null);
    const refresh = () => queryClient.invalidateQueries({ queryKey: ["ltc-utxos", address] });
    // the signed transaction: from the browser wallet's key, or back from the extension
    let hex: string;
    let txid: string;
    try {
      if (built.tx) {
        ({ hex, txid } = built.tx);
      } else {
        setBusy("signing");
        const signed = await extension.signPsbt(built.unsigned!.psbt, built.unsigned!.toSign);
        ({ hex, txid } = finishSigned(signed, built.unsigned!, LTC_NETWORK));
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(/reject|cancel|denied|closed/i.test(msg) ? `Not signed: ${signer} refused it, or the request was closed.` : msg);
      setBusy("");
      return;
    }
    setBusy("broadcasting");
    const spent = { txid, inputs: plan.inputs, outputs: plan.outputs, change: plan.change };
    try {
      const id = await api.broadcast(hex);
      noteSpend(spent, address); // the next transaction spends the change, not these coins again
      setSent(id);
      onSent?.(id);
      refresh();
      setTimeout(refresh, 5_000);
    } catch (e) {
      const msg = (e as Error).message;
      if (/mempool-conflict|missingorspent|missing inputs|already spent/i.test(msg)) {
        setError(
          "These coins are already being spent by a transaction that is still waiting for a block — an earlier click that did go through? " +
            "Check your address on the explorer. After the next block (~2.5 min) the wallet spends the change instead."
        );
      } else if (/timeout|aborted|HTTP 5\d\d|fetch failed|unreachable/i.test(msg)) {
        // the explorer did not answer: it may still have relayed the transaction
        noteSpend(spent, address);
        refresh();
        setError(`${msg} — the transaction may have gone through anyway: check your address on the explorer before sending again.`);
      } else {
        setError(msg);
      }
    } finally {
      setBusy("");
    }
  }

  const short = built.problem?.startsWith("insufficient") || built.problem?.includes("no coins");

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{title}</span>
        <span className="font-mono text-sm text-white">{fmtLtc(total, 8)} LTC</span>
      </div>
      <div className="divide-y divide-white/[0.06] font-mono text-xs">
        {payments.map((p, i) => (
          <Row key={i} k={i === 0 ? "To the desk" : `Output ${i}`} v={`${fmtLtc(p.lit, 8)} LTC → ${p.address.slice(0, 12)}…`} />
        ))}
        {memo && <Row k={`Memo · ${bytes}/${MEMO_MAX_BYTES} bytes`} v={memo} wrap />}
        <Row k="Network fee" v={plan ? `${fmtLtc(plan.fee, 8)} LTC · ${plan.vsize} vB @ ${feeRate} lit/vB` : feeRate ? "—" : "fetching…"} />
        <Row k="From" v={signer ? `${address} · ${signer}` : address} wrap />
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
        disabled={!plan || !!busy}
        onClick={submit}
        className="btn-primary w-full py-2 text-sm"
      >
        {busy === "signing" ? `Waiting for ${signer}…` : busy ? "Broadcasting…" : signer ? confirmLabel.replace(/^Sign/, `Sign in ${signer}`) : confirmLabel}
      </button>
      <p className="text-[11px] text-zinc-600">
        {note ?? (signer ? `Signed in ${signer}, whose keys stay there; nothing but the signed transaction leaves it.` : "Signed in this browser with your wallet key; nothing but the signed transaction leaves it.")} Folded into the
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
