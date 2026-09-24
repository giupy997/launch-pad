"use client";

import { useState } from "react";
import { CURVE_SUPPLY, MEMO_MAX_BYTES, memo, memoBytes, quoteBuy, quoteSell, spotPrice } from "@/lib/litecoin/ledger";
import { CARRY_LIT } from "@/lib/litecoin/tx";
import { addressLink, fmtCoins, fmtLtc, fmtPrice, parseLtc, shortAddr, txLink, useLitecoinState, useLtcWallet, type LCoin, type LState } from "@/lib/litecoin/client";
import { SendPanel } from "@/components/litecoin/SendPanel";
import { NeedsLtcWallet } from "@/components/litecoin/Wallet";
import { TokenLogo } from "@/components/TokenLogo";
import { PriceChart } from "@/components/PriceChart";

const URL_OK = /^(https?:\/\/|ipfs:\/\/)\S{1,300}$/;

export default function LitecoinCoinPage({ params }: { params: { ticker: string } }) {
  const ticker = decodeURIComponent(params.ticker).toUpperCase();
  const { data: state, isLoading } = useLitecoinState();
  const coin = state?.coins.find((c) => c.ticker === ticker);

  if (isLoading && !state) return <div className="h-64 rounded-xl bg-zinc-900 animate-pulse" />;
  if (!state || !coin) {
    return (
      <p className="text-zinc-500">
        ${ticker} is not in the ledger. A fresh deploy shows up after 2 confirmations (~5 minutes).
      </p>
    );
  }

  const progress = Number((BigInt(coin.sold) * 10_000n) / CURVE_SUPPLY) / 100;
  const trades = state.trades.filter((t) => t.ticker === ticker);
  const points = trades.filter((t) => t.tokens !== "0").map((t) => Number(t.lit) / Number(t.tokens));
  const holders = Object.entries(state.balances[ticker] ?? {}).sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1));

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6 order-2 lg:order-1">
        <div className="flex items-start gap-4">
          <TokenLogo uri={coin.logo} symbol={coin.ticker} size={72} />
          <div>
            <h1 className="text-3xl font-bold">
              {coin.name} <span className="font-mono text-lg text-zinc-400">${coin.ticker}</span>
              {coin.feesToHolders && (
                <span className="ml-3 font-mono text-xs tracking-widest uppercase border border-white rounded-full px-2 py-0.5 align-middle">
                  ✦ Rewards
                </span>
              )}
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              creator{" "}
              <a href={addressLink(coin.creator)} target="_blank" rel="noreferrer" className="underline hover:text-zinc-300">
                {shortAddr(coin.creator)}
              </a>{" "}
              · born in block {coin.createdHeight.toLocaleString("en-US")} · paired with <span className="text-zinc-300">LTC</span>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Price" value={`${fmtPrice(spotPrice(coin))} LTC`} />
          <Stat label="In the curve" value={`${fmtLtc(coin.realLit)} LTC`} />
          <Stat label="Sold" value={fmtCoins(coin.sold)} />
          <Stat label="Holders" value={String(coin.holders)} />
        </div>

        <div>
          <div className="h-2 rounded bg-zinc-800 overflow-hidden">
            <div className="h-full bg-white" style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {progress.toFixed(1)}% of the 800M on the curve. There is no DEX to graduate to on Litecoin: the curve
            stays the market, so a sell always fills.
          </p>
        </div>

        <PriceChart points={points} quoteSymbol="LTC" />

        <div className="rounded-xl border border-zinc-800 bg-black p-4">
          <h2 className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-3">Trades</h2>
          {trades.length === 0 && <p className="text-sm text-zinc-600">No trades yet.</p>}
          <div className="space-y-1.5">
            {[...trades].reverse().slice(0, 30).map((t, i) => (
              <a key={`${t.txid}-${i}`} href={txLink(t.txid)} target="_blank" rel="noreferrer" className="flex justify-between gap-3 text-xs font-mono hover:text-white">
                <span className={t.type === "buy" ? "text-white" : "text-zinc-500"}>{t.type.toUpperCase()}</span>
                <span className="text-zinc-400">{shortAddr(t.holder)}</span>
                <span className="text-zinc-300">{fmtCoins(t.tokens)}</span>
                <span className="text-zinc-400">{fmtLtc(t.lit)} LTC</span>
                <span className="text-zinc-600">#{t.height}</span>
              </a>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-black p-4">
          <h2 className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-3">Holders</h2>
          <div className="space-y-1.5">
            {holders.slice(0, 20).map(([h, v]) => (
              <div key={h} className="flex justify-between text-xs font-mono">
                <a href={addressLink(h)} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-white">
                  {shortAddr(h)}{h === coin.creator && " · creator"}
                </a>
                <span className="text-zinc-300">{fmtCoins(v)} · {((Number(v) / Number(CURVE_SUPPLY)) * 80).toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="order-1 lg:order-2 space-y-4">
        <TradeBox coin={coin} state={state} />
        <CreatorPanel coin={coin} state={state} />
      </div>
    </div>
  );
}

function TradeBox({ coin, state }: { coin: LCoin; state: LState }) {
  const { ready, address } = useLtcWallet();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState(100);

  const c = { vLit: BigInt(coin.vLit), vToken: BigInt(coin.vToken), realLit: BigInt(coin.realLit), sold: BigInt(coin.sold) };
  const balance = BigInt((address && state.balances[coin.ticker]?.[address]) || "0");
  const desk = state.desk.address;

  if (ready && !address) return <NeedsLtcWallet />;
  if (!desk || !address) return null;

  const litIn = parseLtc(amount);
  const buyQ = litIn > 0n ? quoteBuy(c, litIn) : null;
  const sellAmount = (balance * BigInt(percent)) / 100n;
  const sellQ = sellAmount > 0n ? quoteSell(c, sellAmount) : null;

  return (
    <div className="rounded-xl border border-zinc-800 bg-black p-5 space-y-4 lg:sticky lg:top-24">
      <div className="grid grid-cols-2 rounded-lg bg-zinc-900 p-1 text-sm font-semibold">
        {(["buy", "sell"] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`rounded-md py-1.5 capitalize ${mode === m ? "bg-white text-black" : "text-zinc-400"}`}>
            {m}
          </button>
        ))}
      </div>

      {mode === "buy" ? (
        <>
          <div className="flex gap-2 flex-wrap">
            {["0.01", "0.05", "0.1"].map((v) => (
              <button key={v} type="button" onClick={() => setAmount(v)} className="rounded-full border border-zinc-700 px-3 py-1 text-xs font-mono text-zinc-400 hover:border-white hover:text-white">
                {v} LTC
              </button>
            ))}
          </div>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0 LTC" type="number" min="0" step="any"
            className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none text-right" />
          {buyQ && buyQ.tokensOut > 0n && (
            <>
              <p className="text-sm text-zinc-400">
                ≈ <span className="text-white">{fmtCoins(buyQ.tokensOut)}</span> ${coin.ticker}
                {buyQ.refund > 0n && <> · {fmtLtc(buyQ.refund)} LTC over the curve stays yours (claimable)</>}
              </p>
              <SendPanel
                payments={[{ address: desk, lit: litIn }]}
                memo={memo.buy(coin.ticker, (buyQ.tokensOut * 97n) / 100n)}
                title={`Buy $${coin.ticker}`}
                note="Coins are credited to the address this wallet pays from. If the price moves more than 3% the LTC is credited back to you instead."
              />
            </>
          )}
          {buyQ && buyQ.tokensOut === 0n && <p className="text-sm text-zinc-500">The curve is sold out — buys reopen when someone sells.</p>}
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-400">
            You hold <span className="text-white">{fmtCoins(balance)}</span> ${coin.ticker}
          </p>
          <div className="flex gap-2">
            {[25, 50, 75, 100].map((p) => (
              <button key={p} type="button" onClick={() => setPercent(p)}
                className={`flex-1 rounded-full py-1 text-xs font-mono ${percent === p ? "bg-white text-black" : "border border-zinc-700 text-zinc-400 hover:border-white"}`}>
                {p}%
              </button>
            ))}
          </div>
          {sellQ && (
            <>
              <p className="text-sm text-zinc-400">
                {fmtCoins(sellAmount)} ${coin.ticker} → <span className="text-white">{fmtLtc(sellQ.net, 8)} LTC</span>
              </p>
              <SendPanel
                payments={[{ address: desk, lit: CARRY_LIT }]}
                memo={memo.sell(coin.ticker, sellAmount, (sellQ.net * 97n) / 100n)}
                title={`Sell $${coin.ticker}`}
                note="The order is the OP_RETURN; the payment is only dust that carries it (credited back). The desk then pays the LTC to this wallet's address."
              />
            </>
          )}
          {balance === 0n && <p className="text-sm text-zinc-600">Nothing to sell from this wallet.</p>}
        </>
      )}
      <p className="text-xs text-zinc-600">
        1% fee · {coin.feesToHolders ? "80% holder cashback" : "80% creator"} · 20% desk
      </p>
    </div>
  );
}

/** The creator can set or change the logo in its own transaction (only the creator address is honoured). */
function CreatorPanel({ coin, state }: { coin: LCoin; state: LState }) {
  const { address } = useLtcWallet();
  const [url, setUrl] = useState("");
  const [open, setOpen] = useState(false);
  const desk = state.desk.address;
  if (!address || !desk || address !== coin.creator) return null;
  const u = url.trim();
  const m = memo.logo(coin.ticker, u || "https://x");
  const ok = URL_OK.test(u) && memoBytes(m) <= MEMO_MAX_BYTES;
  return (
    <div className="rounded-xl border border-zinc-800 bg-black p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Creator · logo</span>
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-zinc-400 underline">
          {open ? "close" : coin.logo ? "change" : "set a logo"}
        </button>
      </div>
      {open && (
        <>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… or ipfs://… (square image)" type="url"
            className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-xs font-mono focus:border-white outline-none placeholder:text-zinc-600" />
          {u && !URL_OK.test(u) && <p className="text-[11px] text-zinc-500">⚠ http(s) or ipfs URL, no spaces.</p>}
          {u && URL_OK.test(u) && memoBytes(m) > MEMO_MAX_BYTES && (
            <p className="text-[11px] text-zinc-500">⚠ {memoBytes(m)}/{MEMO_MAX_BYTES} bytes — use a shorter URL (an ipfs://Qm… CID fits).</p>
          )}
          {ok && (
            <SendPanel payments={[{ address: desk, lit: CARRY_LIT }]} memo={m} title={`Set $${coin.ticker} logo`}
              note="Only a transaction paid from the creator address changes the logo; the dust is credited back." />
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-black p-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-sm">{value}</div>
    </div>
  );
}
