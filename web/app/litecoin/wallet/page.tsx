"use client";

import Link from "next/link";
import { useState } from "react";
import { PARAMS, memo, spotPrice } from "@/lib/litecoin/ledger";
import { CARRY_LIT, DUST_LIT, isAddress } from "@/lib/litecoin/tx";
import { LTC_NETWORK, fmtCoins, fmtLtc, parseLtc, txLink, useLitecoinState, useLtcWallet, useUtxos } from "@/lib/litecoin/client";
import { FundPanel, NeedsLtcWallet } from "@/components/litecoin/Wallet";
import { SendPanel } from "@/components/litecoin/SendPanel";

export default function LitecoinWallet() {
  const { data: state } = useLitecoinState();
  const { ready, secret, wallet, address, forget } = useLtcWallet();
  const { balance } = useUtxos(address);
  const [reveal, setReveal] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");

  if (!ready) return null;
  if (!address || !secret || !wallet) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase text-center">Wallet</h1>
        <NeedsLtcWallet />
      </div>
    );
  }

  const holdings = (state?.coins ?? [])
    .map((c) => ({ coin: c, balance: BigInt(state?.balances[c.ticker]?.[address] ?? "0") }))
    .filter((h) => h.balance > 0n);
  const created = (state?.coins ?? []).filter((c) => c.creator === address);
  const claimable = BigInt(state?.claimable[address] ?? "0");
  const minPayout = PARAMS[LTC_NETWORK].minPayoutLit;
  const myPayouts = (state?.payouts ?? []).filter((p) => p.holder === address).reverse();
  const desk = state?.desk.address ?? null;
  const withdrawLit = parseLtc(amount);
  const withdrawOk = isAddress(to.trim(), LTC_NETWORK) && withdrawLit >= DUST_LIT;

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Wallet</h1>

      <FundPanel address={address} />

      <section className="rounded-xl border border-zinc-800 bg-black p-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <Label>Claimable LTC — creator fees, holder cashback, refunds, carried dust</Label>
          <span className="font-mono text-lg">{fmtLtc(claimable, 8)}</span>
        </div>
        {claimable + CARRY_LIT < minPayout ? (
          <p className="text-xs text-zinc-600">Claims open from {fmtLtc(minPayout)} LTC — below that a network fee would eat it. It keeps accruing.</p>
        ) : !claiming ? (
          <button type="button" disabled={!desk} onClick={() => setClaiming(true)}
            className="w-full rounded-full bg-white py-2 text-sm font-semibold text-black hover:bg-zinc-200 disabled:opacity-40">
            Claim to this wallet
          </button>
        ) : (
          desk && (
            <SendPanel
              payments={[{ address: desk, lit: CARRY_LIT }]}
              memo={memo.claim()}
              title="Claim"
              note="The claim is the OP_RETURN; the dust that carries it is credited back. The desk then pays everything owed to this wallet's address."
            />
          )
        )}
      </section>

      <section className="rounded-xl border border-zinc-800 bg-black p-5 space-y-3">
        <Label>Withdraw — send LTC from this wallet anywhere</Label>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Litecoin address"
          className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-xs font-mono focus:border-white outline-none placeholder:text-zinc-600" />
        <div className="flex gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0 LTC" type="number" min="0" step="any"
            className="flex-1 rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none text-right" />
          <button type="button" onClick={() => setAmount((Number(balance) / 1e8 - 0.0001).toFixed(8).replace(/\.?0+$/, ""))}
            className="rounded-full border border-zinc-700 px-3 text-xs text-zinc-300 hover:border-white">
            max
          </button>
        </div>
        {to.trim() && !isAddress(to.trim(), LTC_NETWORK) && <p className="text-xs text-zinc-500">⚠ Not a {LTC_NETWORK === "test" ? "testnet" : "mainnet"} Litecoin address.</p>}
        {withdrawOk && <SendPanel payments={[{ address: to.trim(), lit: withdrawLit }]} memo={null} title="Withdraw" confirmLabel="Sign & send" note="A plain Litecoin payment from your wallet." />}
      </section>

      <section>
        <Label>Holdings</Label>
        {holdings.length === 0 && <p className="text-sm text-zinc-600">No coins yet. <Link href="/litecoin" className="underline">Explore</Link></p>}
        <div className="space-y-2">
          {holdings.map(({ coin, balance: bal }) => (
            <Link key={coin.ticker} href={`/litecoin/c/${coin.ticker}`} className="flex justify-between rounded-lg border border-zinc-800 px-4 py-3 text-sm hover:border-white">
              <span className="font-mono">${coin.ticker}</span>
              <span className="text-zinc-400">
                {fmtCoins(bal)} · ≈ {fmtLtc(BigInt(Math.floor(spotPrice(coin) * Number(bal))))} LTC
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
              <Link key={c.ticker} href={`/litecoin/c/${c.ticker}`} className="rounded-full border border-zinc-700 px-3 py-1 text-xs font-mono hover:border-white">
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
                <span className="text-zinc-300">{fmtLtc(p.lit, 8)} LTC</span>
                {p.paidTxid ? (
                  <a href={txLink(p.paidTxid)} target="_blank" rel="noreferrer" className="text-white underline">paid ✓</a>
                ) : (
                  <span className="text-zinc-500">due</span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-800 bg-black p-5 space-y-3">
        <Label>Key — back it up; it cannot be recovered or reset</Label>
        {reveal ? (
          <>
            <Label>Secret (paste on another device to restore)</Label>
            <Copyable value={secret} />
            <Label>WIF (import into Electrum-LTC as p2wpkh:…)</Label>
            <Copyable value={`p2wpkh:${wallet.wif}`} />
          </>
        ) : (
          <button type="button" onClick={() => setReveal(true)} className="rounded-full border border-zinc-700 px-4 py-1.5 text-xs text-zinc-300 hover:border-white">
            Reveal secret
          </button>
        )}
        <button
          type="button"
          onClick={() => confirm("Remove this wallet from this browser? Without a backup of the secret its LTC and coins are lost for good.") && forget()}
          className="block text-xs text-zinc-600 underline"
        >
          Remove from this browser
        </button>
      </section>
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
