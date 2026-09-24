"use client";

import Link from "next/link";
import { useState } from "react";
import { MEMO_MAX_BYTES, PARAMS, VIRTUAL_TOKEN, memo, memoBytes, quoteBuy } from "@/lib/litecoin/ledger";
import { LTC_NETWORK, fmtCoins, fmtLtc, parseLtc, useLitecoinState, useLtcWallet } from "@/lib/litecoin/client";
import { SendPanel } from "@/components/litecoin/SendPanel";
import { NeedsLtcWallet } from "@/components/litecoin/Wallet";
import { TokenLogo } from "@/components/TokenLogo";

const inputCls =
  "w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none placeholder:text-zinc-600";
const P = PARAMS[LTC_NETWORK];
const URL_OK = /^(https?:\/\/|ipfs:\/\/)\S{1,300}$/;

export default function LitecoinCreate() {
  const { data: state } = useLitecoinState();
  const { ready, address } = useLtcWallet();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  const [feesToHolders, setFeesToHolders] = useState(false);
  const [devBuy, setDevBuy] = useState("");

  const ticker = symbol.trim().toUpperCase();
  const tickerOk = /^[A-Z0-9]{2,8}$/.test(ticker);
  const taken = !!state?.coins.some((c) => c.ticker === ticker);
  const devBuyLit = parseLtc(devBuy);
  const logoUrl = logo.trim();
  const logoOk = !logoUrl || URL_OK.test(logoUrl);
  const bare = memo.deploy(ticker || "TICKER", name.trim() || "name", feesToHolders);
  const withLogo = logoUrl ? memo.deploy(ticker || "TICKER", name.trim() || "name", feesToHolders, logoUrl) : bare;
  const nameFits = memoBytes(bare) <= MEMO_MAX_BYTES;
  const logoFits = memoBytes(withLogo) <= MEMO_MAX_BYTES;
  const desk = state?.desk.address ?? null;
  const valid = tickerOk && !taken && name.trim().length > 0 && nameFits && logoOk && !!address && !!desk;
  const est = devBuyLit > 0n ? quoteBuy({ vLit: P.virtualLit, vToken: VIRTUAL_TOKEN, sold: 0n }, devBuyLit).tokensOut : 0n;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5 order-2 lg:order-1">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Deploy a coin</h1>
          <p className="mt-2 text-sm text-zinc-500">
            One transaction claims the ticker. The first paid deploy wins it, and its rules are fixed forever —
            there is no admin key here, only what the OP_RETURN said.
          </p>
        </div>

        {ready && !address && <NeedsLtcWallet />}
        {state && !desk && (
          <p className="rounded-xl border border-dashed border-zinc-700 p-3 text-xs text-zinc-400">
            The desk is not live yet — deploys open once the indexer publishes its address.
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Name</Label>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="Coin name" className={inputCls} />
            {!nameFits && <Hint>⚠ Too long for one OP_RETURN once encoded — a space costs 3 bytes. Shorten it.</Hint>}
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
          <Label>
            Logo URL <span className="normal-case text-zinc-600">optional · square image · shares the 80 bytes with the name</span>
          </Label>
          <input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="https://… or ipfs://…" type="url" className={inputCls} />
          {logoUrl && !logoOk && <Hint>⚠ http(s) or ipfs URL, no spaces.</Hint>}
          {logoUrl && logoOk && !logoFits && (
            <Hint>
              ⚠ It does not fit next to this name ({memoBytes(withLogo)}/{MEMO_MAX_BYTES} bytes). The coin deploys without it —
              set it afterwards from the coin page, in its own transaction. Only you can.
            </Hint>
          )}
        </div>

        <div>
          <Label>Trading fees <span className="normal-case text-zinc-600">1% per trade · 20% desk · you pick where the other 80% goes, locked forever</span></Label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ModeCard title="Keep the fees" detail="80% of every trade fee accrues to your address" selected={!feesToHolders} onClick={() => setFeesToHolders(false)} />
            <ModeCard title="Reward holders" detail="80% of every trade fee is LTC cashback for your holders" selected={feesToHolders} onClick={() => setFeesToHolders(true)} />
          </div>
        </div>

        <div>
          <Label>Dev buy <span className="normal-case text-zinc-600">optional — LTC sent on top of the deploy fee buys the first coins, in the same transaction</span></Label>
          <input value={devBuy} onChange={(e) => setDevBuy(e.target.value)} placeholder="0.0 LTC" type="number" min="0" step="any" className={`${inputCls} sm:w-48`} />
          {est > 0n && <Hint>≈ {fmtCoins(est)} ${ticker || "COINS"} at the opening price</Hint>}
        </div>

        {valid ? (
          <SendPanel
            payments={[{ address: desk!, lit: P.deployFeeLit + devBuyLit }]}
            memo={memo.deploy(ticker, name.trim(), feesToHolders, logoFits ? logoUrl : "")}
            title={`Deploy $${ticker}`}
            note="Your wallet pays the desk and writes the deploy in the OP_RETURN; the address it pays from becomes the creator."
          />
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-800 p-4 text-sm text-zinc-600">
            Fill the coin in and the transaction appears here, ready to sign.
          </p>
        )}
        {valid && (
          <p className="text-xs text-zinc-500">
            Once it confirms, your coin lives at{" "}
            <Link href={`/litecoin/c/${ticker}`} className="underline text-zinc-300">/litecoin/c/{ticker}</Link>.
          </p>
        )}
      </div>

      <aside className="order-1 lg:order-2">
        <div className="lg:sticky lg:top-24 rounded-xl border border-zinc-800 bg-black p-5 space-y-4">
          <div className="flex items-center gap-3">
            <TokenLogo uri={logoOk ? logoUrl : ""} symbol={ticker || "?"} size={56} />
            <div className="min-w-0">
              <div className="font-mono text-xl font-bold">${ticker || "TICKER"}</div>
              <div className="text-sm text-zinc-400 truncate">{name || "Your coin name"}</div>
            </div>
          </div>
          <div className="divide-y divide-zinc-900 font-mono text-xs">
            <Row k="Deploy cost" v={`${fmtLtc(P.deployFeeLit)} LTC + network fee`} />
            <Row k="Trading fees" v="1% buy · 1% sell" />
            <Row k="Fee split" v={feesToHolders ? "80% holders · 20% desk" : "80% you · 20% desk"} strong />
            <Row k="Supply" v="1B fixed · 800M on the curve" />
            <Row k="Curve raises" v={`~${fmtLtc((P.virtualLit * 32n) / 10n, 2)} LTC`} />
            <Row k="Market" v="The curve, forever — sells always fill" strong />
            <Row k="Reserve" v="200M held back" />
          </div>
          <p className="text-[11px] text-zinc-600">
            The desk holds the LTC sent to the curve and the ledger is the only record of balances.{" "}
            <Link href="/litecoin/ledger" className="underline">Check the arithmetic.</Link>
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
