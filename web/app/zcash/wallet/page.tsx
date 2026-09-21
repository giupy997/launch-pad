"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PARAMS, memo, spotPrice } from "@/lib/zcash/ledger";
import { DUST_ZAT, ZCASH_NETWORK, fmtCoins, fmtZec, useHolderKey, useZcashState } from "@/lib/zcash/client";
import { NeedsHolderKey } from "@/components/zcash/HolderKey";
import { PaymentPanel } from "@/components/zcash/PaymentPanel";

export default function ZcashWallet() {
  const { data: state } = useZcashState();
  const { ready, secret, holder, forget } = useHolderKey();
  const [reveal, setReveal] = useState(false);
  const [payout, setPayout] = useState("");
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    try {
      setPayout(localStorage.getItem("notus.zcash.payout") ?? "");
    } catch {}
  }, []);

  if (!ready) return null;
  if (!holder || !secret) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase text-center">Holder key</h1>
        <NeedsHolderKey />
      </div>
    );
  }

  const holdings = (state?.coins ?? [])
    .map((c) => ({ coin: c, balance: BigInt(state?.balances[c.ticker]?.[holder] ?? "0") }))
    .filter((h) => h.balance > 0n);
  const created = (state?.coins ?? []).filter((c) => c.creator === holder);
  const claimable = BigInt(state?.claimable[holder] ?? "0");
  const minPayout = PARAMS[ZCASH_NETWORK].minPayoutZat;
  const payoutOk = /^(utest1|ztestsapling1|tm|u1|zs1|t1)[0-9a-zA-Z]{20,400}$/.test(payout.trim());
  const myPayouts = (state?.payouts ?? []).filter((p) => p.holder === holder).reverse();
  const nonce = BigInt(state?.nonces[holder] ?? "0") + 1n;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Holder key</h1>

      <section className="rounded-xl border border-zinc-800 bg-black p-5 space-y-3">
        <Label>Public key — this is who owns your coins</Label>
        <Copyable value={holder} />
        <Label>Secret — back it up; it cannot be recovered or reset</Label>
        {reveal ? <Copyable value={secret} /> : (
          <button type="button" onClick={() => setReveal(true)} className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:border-white">
            Reveal secret
          </button>
        )}
        <button
          type="button"
          onClick={() => confirm("Remove this key from this browser? Without a backup of the secret the balances are lost for good.") && forget()}
          className="block text-xs text-zinc-600 underline"
        >
          Remove from this browser
        </button>
      </section>

      <section className="rounded-xl border border-zinc-800 bg-black p-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <Label>Claimable ZEC — creator fees, holder cashback, refunds</Label>
          <span className="font-mono text-lg">{fmtZec(claimable, 8)}</span>
        </div>
        <input
          value={payout}
          onChange={(e) => {
            setPayout(e.target.value);
            try { localStorage.setItem("notus.zcash.payout", e.target.value.trim()); } catch {}
          }}
          placeholder="Your Zcash address — where the ZEC is paid"
          className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-xs font-mono focus:border-white outline-none placeholder:text-zinc-600"
        />
        {claimable + DUST_ZAT < minPayout ? (
          <p className="text-xs text-zinc-600">Claims open from {fmtZec(minPayout)} ZEC — below that a network fee would eat it. It keeps accruing.</p>
        ) : !claiming ? (
          <button type="button" disabled={!payoutOk} onClick={() => setClaiming(true)}
            className="w-full rounded-full bg-white py-2 text-sm font-semibold text-black hover:bg-zinc-200 disabled:opacity-40">
            {payoutOk ? "Claim" : "Enter your address to claim"}
          </button>
        ) : (
          state?.desk.address && (
            <PaymentPanel
              address={state.desk.address}
              zat={DUST_ZAT}
              memo={memo.claim(secret, ZCASH_NETWORK, payout.trim(), nonce)}
              title="Claim"
              note="The claim is the signature inside the memo. The desk then pays everything owed to your address."
            />
          )
        )}
      </section>

      <section>
        <Label>Holdings</Label>
        {holdings.length === 0 && <p className="text-sm text-zinc-600">No coins yet. <Link href="/zcash" className="underline">Explore</Link></p>}
        <div className="space-y-2">
          {holdings.map(({ coin, balance }) => (
            <Link key={coin.ticker} href={`/zcash/c/${coin.ticker}`} className="flex justify-between rounded-lg border border-zinc-800 px-4 py-3 text-sm hover:border-white">
              <span className="font-mono">${coin.ticker}</span>
              <span className="text-zinc-400">
                {fmtCoins(balance)} · ≈ {fmtZec(BigInt(Math.floor(spotPrice(coin) * Number(balance))))} ZEC
              </span>
            </Link>
          ))}
        </div>
      </section>

      {created.length > 0 && (
        <section>
          <Label>Deployed by you</Label>
          <div className="flex gap-2 flex-wrap">
            {created.map((c) => (
              <Link key={c.ticker} href={`/zcash/c/${c.ticker}`} className="rounded-full border border-zinc-700 px-3 py-1 text-xs font-mono hover:border-white">
                ${c.ticker}
              </Link>
            ))}
          </div>
        </section>
      )}

      {myPayouts.length > 0 && (
        <section>
          <Label>Your payouts</Label>
          <div className="space-y-1.5">
            {myPayouts.map((p) => (
              <div key={p.id} className="flex justify-between text-xs font-mono">
                <span className="text-zinc-500">#{p.id} {p.kind}</span>
                <span className="text-zinc-300">{fmtZec(p.zat, 8)} ZEC</span>
                <span className={p.paidTxid ? "text-white" : "text-zinc-500"}>{p.paidTxid ? "paid ✓" : "due"}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-1.5">{children}</div>;
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
