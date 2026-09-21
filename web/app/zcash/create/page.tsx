"use client";

import Link from "next/link";
import { useState } from "react";
import { PARAMS, VIRTUAL_TOKEN, memo, quoteBuy } from "@/lib/zcash/ledger";
import { ZCASH_NETWORK, fmtCoins, fmtZec, parseZec, useHolderKey, useZcashState } from "@/lib/zcash/client";
import { PaymentPanel } from "@/components/zcash/PaymentPanel";
import { NeedsHolderKey } from "@/components/zcash/HolderKey";
import { TokenLogo } from "@/components/TokenLogo";

const inputCls =
  "w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none placeholder:text-zinc-600";
const P = PARAMS[ZCASH_NETWORK];

export default function ZcashCreate() {
  const { data: state } = useZcashState();
  const { ready, holder } = useHolderKey();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [feesToHolders, setFeesToHolders] = useState(false);
  const [devBuy, setDevBuy] = useState("");

  const ticker = symbol.trim().toUpperCase();
  const tickerOk = /^[A-Z0-9]{2,8}$/.test(ticker);
  const taken = !!state?.coins.some((c) => c.ticker === ticker);
  const devBuyZat = parseZec(devBuy);
  const valid = tickerOk && !taken && name.trim().length > 0 && !!holder && !!state?.desk.address;
  const est = devBuyZat > 0n ? quoteBuy({ vZat: P.virtualZat, vToken: VIRTUAL_TOKEN, sold: 0n }, devBuyZat).tokensOut : 0n;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5 order-2 lg:order-1">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Deploy a coin</h1>
          <p className="mt-2 text-sm text-zinc-500">
            One memo claims the ticker. The first paid deploy wins it, and its rules are fixed forever —
            there is no admin key here, only what the memo said.
          </p>
        </div>

        {ready && !holder && <NeedsHolderKey />}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Name</Label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Coin name" className={inputCls} />
          </div>
          <div>
            <Label>Ticker</Label>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              maxLength={8}
              placeholder="2–8 letters or digits"
              className={`${inputCls} uppercase`}
            />
            {ticker && !tickerOk && <Hint>⚠ 2 to 8 characters, A–Z and 0–9.</Hint>}
            {taken && <Hint>⚠ ${ticker} is already taken.</Hint>}
          </div>
        </div>

        <div>
          <Label>Logo URL <span className="normal-case text-zinc-600">optional · square image · a memo has no room for the file itself</span></Label>
          <input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://…" type="url" className={inputCls} />
        </div>

        <div>
          <Label>Trading fees <span className="normal-case text-zinc-600">1% per trade · 20% desk · you pick where the other 80% goes, locked forever</span></Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ModeCard title="Keep the fees" detail="80% of every trade fee accrues to your holder key" selected={!feesToHolders} onClick={() => setFeesToHolders(false)} />
            <ModeCard title="Reward holders" detail="80% of every trade fee is ZEC cashback for your holders" selected={feesToHolders} onClick={() => setFeesToHolders(true)} />
          </div>
        </div>

        <div>
          <Label>Dev buy <span className="normal-case text-zinc-600">optional — ZEC sent on top of the deploy fee buys the first coins, in the same memo</span></Label>
          <input value={devBuy} onChange={(e) => setDevBuy(e.target.value)} placeholder="0.0 ZEC" type="number" min="0" step="any" className={`${inputCls} sm:w-48`} />
          {est > 0n && <Hint>≈ {fmtCoins(est)} ${ticker || "COINS"} at the opening price</Hint>}
        </div>

        {valid ? (
          <PaymentPanel
            address={state!.desk.address!}
            zat={P.deployFeeZat + devBuyZat}
            memo={memo.deploy(ticker, name.trim(), holder!, feesToHolders, logo.trim())}
            title={`Deploy $${ticker}`}
            note="Send exactly this from any shielded Zcash wallet to claim the ticker."
          />
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-800 p-4 text-sm text-zinc-600">
            Fill the coin in and the payment appears here, with the memo already written.
          </p>
        )}
        {valid && (
          <p className="text-xs text-zinc-500">
            Once it confirms, your coin lives at{" "}
            <Link href={`/zcash/c/${ticker}`} className="underline text-zinc-300">/zcash/c/{ticker}</Link>.
          </p>
        )}
      </div>

      <aside className="order-1 lg:order-2">
        <div className="lg:sticky lg:top-24 rounded-xl border border-zinc-800 bg-black p-5 space-y-4">
          <div className="flex items-center gap-3">
            <TokenLogo uri={logo.trim()} symbol={ticker || "?"} size={56} />
            <div className="min-w-0">
              <div className="font-mono text-xl font-bold">${ticker || "TICKER"}</div>
              <div className="text-sm text-zinc-400 truncate">{name || "Your coin name"}</div>
            </div>
          </div>
          <div className="divide-y divide-zinc-900 font-mono text-xs">
            <Row k="Deploy cost" v={`${fmtZec(P.deployFeeZat)} ZEC`} />
            <Row k="Trading fees" v="1% buy · 1% sell" />
            <Row k="Fee split" v={feesToHolders ? "80% holders · 20% desk" : "80% you · 20% desk"} strong />
            <Row k="Supply" v="1B fixed · 800M on the curve" />
            <Row k="Curve raises" v={`~${fmtZec((P.virtualZat * 32n) / 10n, 2)} ZEC`} />
            <Row k="Market" v="The curve, forever — sells always fill" strong />
            <Row k="Reserve" v="200M held for Zcash Shielded Assets" />
          </div>
          <p className="text-[11px] text-zinc-600">
            The desk holds the ZEC sent to the curve and the ledger is the only record of balances
            until native assets exist. <Link href="/zcash/ledger" className="underline">Check the arithmetic.</Link>
          </p>
        </div>
      </aside>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-1.5">{children}</div>;
}
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[11px] text-zinc-500">{children}</p>;
}
function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-2">
      <span className="text-zinc-500">{k}</span>
      <span className={strong ? "text-white text-right" : "text-zinc-300 text-right"}>{v}</span>
    </div>
  );
}
function ModeCard({ title, detail, selected, onClick }: { title: string; detail: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-left ${selected ? "border-white bg-white text-black" : "border-zinc-700 text-zinc-400 hover:border-white hover:text-white"}`}
    >
      <div className="font-mono text-xs font-bold tracking-widest uppercase">{title}</div>
      <div className={`mt-1 text-[11px] ${selected ? "text-zinc-700" : "text-zinc-500"}`}>{detail}</div>
    </button>
  );
}
