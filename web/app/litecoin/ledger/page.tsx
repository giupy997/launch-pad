"use client";

import { useState } from "react";
import { addressLink, fmtLtc, shortAddr, txLink, useLitecoinState } from "@/lib/litecoin/client";

export default function LitecoinLedger() {
  const { data: state } = useLitecoinState();
  if (!state) return <p className="text-zinc-500">The ledger snapshot is not published yet.</p>;

  const due = state.payouts.filter((p) => !p.paidTxid);
  const age = Math.max(0, Math.floor(Date.now() / 1000) - state.updatedAt);

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Ledger</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Litecoin cannot enforce these balances, so they are made checkable instead. Everything below was
          read off the public chain: the transactions paying the desk address, and the OP_RETURN each one
          carries. Run the same rules over the same blocks and you must land on the same state root — if
          you do not, one of us is wrong.
        </p>
      </div>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Ledger height" value={state.height ? state.height.toLocaleString("en-US") : "—"} />
        <Stat label="Chain tip" value={state.chainTip ? state.chainTip.toLocaleString("en-US") : "—"} />
        <Stat label="Transactions read" value={String(state.txsRead)} />
        <Stat label="Snapshot age" value={state.updatedAt ? (age < 120 ? `${age}s` : `${Math.floor(age / 60)} min`) : "—"} />
        <Stat label="Owed to users" value={`${fmtLtc(state.liabilitiesLit, 8)} LTC`} />
        <Stat label="Desk fees" value={`${fmtLtc(state.treasuryLit, 8)} LTC`} />
        <Stat label="Payouts due" value={String(due.length)} />
        <Stat label="Network" value={state.network === "test" ? "testnet" : "mainnet"} />
      </section>

      <section className="space-y-3">
        <Label>The desk — every instruction is a transaction paying this address</Label>
        <Copyable value={state.desk.address ?? "— not published yet —"} />
        {state.desk.address && (
          <a href={addressLink(state.desk.address)} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 underline hover:text-white">
            Its history on the explorer — the balance there must cover what is owed above.
          </a>
        )}
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer text-zinc-400">How to rebuild this ledger</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-zinc-800 p-3 font-mono text-[11px] leading-relaxed text-zinc-400">{`git clone https://github.com/giupy997/launchpadgiwa && cd launchpadgiwa
(cd web && npm install)
# reads every transaction of the desk from litecoinspace.org (or NOTUS_LTC_API=<your Esplora/electrs>),
# replays web/lib/litecoin/ledger.ts and prints the state root:
NOTUS_LTC_DESK=${state.desk.address ?? "<desk address>"} node litecoin/indexer.ts`}</pre>
        </details>
      </section>

      <section>
        <Label>State roots</Label>
        {state.roots.length === 0 && <p className="text-sm text-zinc-600">Nothing folded in yet.</p>}
        <div className="space-y-1">
          {[...state.roots].reverse().slice(0, 15).map((r) => (
            <div key={r.height} className="flex justify-between gap-3 font-mono text-xs">
              <span className="text-zinc-500">#{r.height}</span>
              <span className="text-zinc-300 truncate">{r.root}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <Label>Payouts — what the desk owes and what it has paid</Label>
        {state.payouts.length === 0 && <p className="text-sm text-zinc-600">None yet.</p>}
        <div className="space-y-1">
          {[...state.payouts].reverse().slice(0, 30).map((p) => (
            <div key={p.id} className="grid grid-cols-4 gap-2 font-mono text-xs">
              <span className="text-zinc-500">#{p.id} {p.kind}</span>
              <a href={addressLink(p.to)} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-white">{shortAddr(p.to)}</a>
              <span className="text-zinc-300 text-right">{fmtLtc(p.lit, 8)} LTC</span>
              {p.paidTxid ? (
                <a href={txLink(p.paidTxid)} target="_blank" rel="noreferrer" className="text-right text-white underline">paid {p.paidTxid.slice(0, 8)}…</a>
              ) : (
                <span className="text-right text-zinc-500">due</span>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <Label>Transactions that did nothing</Label>
        {state.rejected.length === 0 && <p className="text-sm text-zinc-600">None.</p>}
        <div className="space-y-1">
          {[...state.rejected].reverse().slice(0, 20).map((r, i) => (
            <div key={i} className="flex justify-between gap-3 font-mono text-xs">
              <a href={txLink(r.txid)} target="_blank" rel="noreferrer" className="text-zinc-500 shrink-0 hover:text-white">#{r.height}</a>
              <span className="text-zinc-400 truncate">{r.memo || "(no memo)"}</span>
              <span className="text-zinc-300 shrink-0">{r.reason}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-800 p-4 text-xs text-zinc-500 space-y-1.5">
        <p className="text-zinc-300 font-semibold">What could cost you</p>
        <p>— The desk holds the LTC. There is no escrow script on Litecoin: what sits in a curve sits with the desk until it is sold back or claimed.</p>
        <p>— This ledger is the only record of balances. Anyone can recompute it; nobody can enforce it.</p>
        <p>— Your coins belong to the address your transactions pay from. Send from your own wallet, never from an exchange: the exchange&apos;s address would own them.</p>
        <p>— A memo typed wrong does nothing — but the LTC that carried it is credited to the sender and can be claimed back.</p>
        <p>— This deployment is on the Litecoin testnet: testnet LTC has no value. Notus is not affiliated with Litecoin or the Litecoin Foundation.</p>
      </section>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-1.5">{children}</div>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-black p-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-sm font-mono">{value}</div>
    </div>
  );
}
function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" title="Copy"
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="block w-full rounded-lg border border-zinc-800 px-3 py-2 text-left font-mono text-xs text-zinc-300 break-all hover:border-white">
      {value} <span className="text-zinc-600">{copied ? "· copied ✓" : "· copy"}</span>
    </button>
  );
}
