"use client";

import Link from "next/link";
import { useState } from "react";
import { MEMO_MAX_BYTES, PARAMS, VIRTUAL_TOKEN, memo, memoBytes, quoteBuy, virtualLitAt } from "@/lib/litecoin/ledger";
import { LTC_NETWORK, fmtCoins, fmtLtc, parseLtc, txLink, useLitecoinState, useLtcWallet } from "@/lib/litecoin/client";
import { SendPanel } from "@/components/litecoin/SendPanel";
import { NeedsLtcWallet } from "@/components/litecoin/Wallet";
import { TokenLogo } from "@/components/TokenLogo";
import { Copyable } from "@/components/litecoin/Copyable";
import { LogoUpload } from "@/components/litecoin/LogoUpload";
import { FrozenNotice } from "@/components/litecoin/FrozenNotice";

const inputCls =
  "w-full rounded-lg input px-3 py-2 text-sm focus:border-white outline-none placeholder:text-zinc-600";
const P = PARAMS[LTC_NETWORK];
const URL_OK = /^(https?:\/\/|ipfs:\/\/)\S{1,300}$/;

export default function LitecoinCreate() {
  const { data: state } = useLitecoinState();
  const { ready, address } = useLtcWallet();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [logo, setLogo] = useState("");
  /** X, Telegram, website: sent from the coin page as a second instruction once the coin is in the ledger. */
  const [links, setLinks] = useState({ x: "", tg: "", web: "" });
  const [feesToHolders, setFeesToHolders] = useState(false);
  const [devBuy, setDevBuy] = useState("");
  /** txid of the deploy just broadcast: the same ticker must not be sent twice. */
  const [deployed, setDeployed] = useState<{ ticker: string; txid: string } | null>(null);

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
  const frozen = !!state?.freezeHeight;
  // the reserve a coin deployed now opens with (a rule change may be a few blocks away)
  const tip = state?.chainTip ?? Number.MAX_SAFE_INTEGER;
  const virtualLit = virtualLitAt(P, tip + 1);
  const upcoming = (P.virtualLitChanges ?? []).find((c) => c.fromHeight > tip + 1);
  const valid = tickerOk && !taken && name.trim().length > 0 && nameFits && logoOk && !!address && !!desk && !frozen;
  const est = devBuyLit > 0n
    ? quoteBuy({ vLit: virtualLit, vToken: VIRTUAL_TOKEN, realLit: 0n, sold: 0n, graduated: false, poolLit: 0n, poolToken: 0n }, devBuyLit).tokensOut
    : 0n;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-5 order-2 lg:order-1">
        <div>
          <h1 className="display text-4xl text-white">Deploy a coin</h1>
          <p className="mt-2 text-sm text-zinc-500">
            One transaction claims the ticker. The first paid deploy wins it, and its rules are fixed forever —
            there is no admin key here, only what the OP_RETURN said.
          </p>
        </div>

        {ready && !address && <NeedsLtcWallet />}
        <FrozenNotice state={state} />
        {state && !desk && (
          <p className="rounded-xl border border-dashed border-white/15 p-3 text-xs text-zinc-400">
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
          <LogoUpload name={ticker || "coin"} onUploaded={setLogo} />
          <input value={logo} onChange={(e) => setLogo(e.target.value)} placeholder="…or paste an image URL: https://… or ipfs://…" type="url" className={`${inputCls} mt-2`} />
          {logoUrl && !logoOk && <Hint>⚠ http(s) or ipfs URL, no spaces.</Hint>}
        </div>

        <div>
          <Label>
            Links <span className="normal-case text-zinc-600">optional · X, Telegram, website · set from the coin page right after the deploy</span>
          </Label>
          <div className="grid gap-2 sm:grid-cols-3">
            <input value={links.x} onChange={(e) => setLinks({ ...links, x: e.target.value })} placeholder="X · @handle" className={inputCls} />
            <input value={links.tg} onChange={(e) => setLinks({ ...links, tg: e.target.value })} placeholder="Telegram · @handle" className={inputCls} />
            <input value={links.web} onChange={(e) => setLinks({ ...links, web: e.target.value })} placeholder="Website · https://…" className={inputCls} />
          </div>
          <Hint>An OP_RETURN holds 80 bytes: the deploy carries name and logo, the links go in their own instruction, one click on the coin page.</Hint>
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

        {deployed ? (
          <div className="card border-white/40 p-4 space-y-2">
            <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Deploy ${deployed.ticker} · broadcast ✓</div>
            <a href={txLink(deployed.txid)} target="_blank" rel="noreferrer" className="block truncate font-mono text-xs text-zinc-300 underline">
              {deployed.txid}
            </a>
            <p className="text-[11px] text-zinc-500">
              After 2 confirmations (~5 minutes) your coin lives at{" "}
              <Link href={`/litecoin/c/${deployed.ticker}`} className="underline text-zinc-300">/litecoin/c/{deployed.ticker}</Link>. Sending the same
              ticker again would only be refunded as a claimable credit.
            </p>
            <div className="pt-1 space-y-1.5">
              <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Share</div>
              <Copyable label="link" value={`${typeof window === "undefined" ? "" : window.location.origin}/litecoin/c/${deployed.ticker}`} />
              <Copyable label="coin id" value={deployed.txid} />
              {(links.x || links.tg || links.web) && (
                <p className="text-[11px] text-zinc-400">
                  Your links are not on the coin yet:{" "}
                  <Link
                    href={`/litecoin/c/${deployed.ticker}?${new URLSearchParams({ x: links.x, tg: links.tg, web: links.web }).toString()}`}
                    className="underline text-zinc-200"
                  >
                    set them from the coin page
                  </Link>{" "}
                  once it is in the ledger (~5 minutes), prefilled — one more signed transaction.
                </p>
              )}
              <p className="text-[11px] text-zinc-600">
                There is no contract address on Litecoin: the ticker is the coin, and this transaction is its birth certificate — anyone can
                verify the coin from it. Buyers only need the link.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setDeployed(null);
                setName("");
                setSymbol("");
                setLogo("");
                setLinks({ x: "", tg: "", web: "" });
                setDevBuy("");
              }}
              className="text-xs text-zinc-500 underline"
            >
              Deploy a different coin
            </button>
          </div>
        ) : valid ? (
          <SendPanel
            payments={[{ address: desk!, lit: P.deployFeeLit + devBuyLit }]}
            memo={memo.deploy(ticker, name.trim(), feesToHolders, logoFits ? logoUrl : "")}
            title={`Deploy $${ticker}`}
            note="Your wallet pays the desk and writes the deploy in the OP_RETURN; the address it pays from becomes the creator."
            onSent={(txid) => setDeployed({ ticker, txid })}
          />
        ) : (
          <p className="rounded-xl border border-dashed border-white/10 p-4 text-sm text-zinc-600">
            Fill the coin in and the transaction appears here, ready to sign.
          </p>
        )}
        {valid && !deployed && (
          <p className="text-xs text-zinc-500">
            Once it confirms, your coin lives at{" "}
            <Link href={`/litecoin/c/${ticker}`} className="underline text-zinc-300">/litecoin/c/{ticker}</Link>.
          </p>
        )}
      </div>

      <aside className="order-1 lg:order-2">
        <div className="lg:sticky lg:top-24 card p-5 space-y-4">
          <div className="flex items-center gap-3">
            <TokenLogo uri={logoOk ? logoUrl : ""} symbol={ticker || "?"} size={56} />
            <div className="min-w-0">
              <div className="font-mono text-xl font-bold">${ticker || "TICKER"}</div>
              <div className="text-sm text-zinc-400 truncate">{name || "Your coin name"}</div>
            </div>
          </div>
          <div className="divide-y divide-white/[0.06] font-mono text-xs">
            <Row k="Deploy cost" v={`${fmtLtc(P.deployFeeLit)} LTC + network fee`} />
            <Row k="Trading fees" v="1% buy · 1% sell" />
            <Row k="Fee split" v={feesToHolders ? "80% holders · 20% desk" : "80% you · 20% desk"} strong />
            <Row k="Supply" v="1B fixed · 800M on the curve" />
            <Row k="Opens with" v={`${fmtLtc(virtualLit, 2)} LTC virtual reserve`} />
            <Row k="Curve raises" v={`~${fmtLtc((virtualLit * 32n) / 10n, 2)} LTC, then it graduates`} />
            {upcoming && (
              <Row k={`From block ${upcoming.fromHeight.toLocaleString("en-US")}`} v={`new coins open with ${fmtLtc(upcoming.virtualLit, 2)} LTC (a deploy mined before keeps ${fmtLtc(virtualLit, 2)})`} />
            )}
            <Row k="After graduation" v="Locked pool: no price ceiling, sells always fill" strong />
            <Row k="Reserve" v="200M seed the pool with the LTC raised" />
            <Row k="Migration" v="Automatic to LitVM at its mainnet: same holders, same price" strong />
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
      className={`rounded-xl border px-4 py-3 text-left ${selected ? "border-white bg-white text-black" : "border-white/15 text-zinc-400 hover:border-white hover:text-white"}`}
    >
      <div className="font-mono text-xs font-bold tracking-widest uppercase">{title}</div>
      <div className={`mt-1 text-[11px] ${selected ? "text-zinc-700" : "text-zinc-500"}`}>{detail}</div>
    </button>
  );
}
