"use client";

import { useEffect, useState } from "react";
import { CURVE_SUPPLY, memo, quoteBuy, quoteSell, spotPrice } from "@/lib/zcash/ledger";
import {
  DUST_ZAT, ZCASH_NETWORK, fmtCoins, fmtPrice, fmtZec, parseZec, shortKey,
  useHolderKey, useZcashState, type ZCoin, type ZState,
} from "@/lib/zcash/client";
import { PaymentPanel } from "@/components/zcash/PaymentPanel";
import { NeedsHolderKey } from "@/components/zcash/HolderKey";
import { TokenLogo } from "@/components/TokenLogo";
import { PriceChart } from "@/components/PriceChart";

export default function ZcashCoinPage({ params }: { params: { ticker: string } }) {
  const ticker = decodeURIComponent(params.ticker).toUpperCase();
  const { data: state, isLoading } = useZcashState();
  const coin = state?.coins.find((c) => c.ticker === ticker);

  if (isLoading && !state) return <div className="h-64 rounded-xl bg-zinc-900 animate-pulse" />;
  if (!state || !coin) {
    return (
      <p className="text-zinc-500">
        ${ticker} is not in the ledger. A fresh deploy shows up after 2 confirmations (~3 minutes).
      </p>
    );
  }

  const progress = Number((BigInt(coin.sold) * 10_000n) / CURVE_SUPPLY) / 100;
  const trades = state.trades.filter((t) => t.ticker === ticker);
  const points = trades.filter((t) => t.tokens !== "0").map((t) => Number(t.zat) / Number(t.tokens));
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
              creator {shortKey(coin.creator)} · born in block {coin.createdHeight.toLocaleString("en-US")} · paired with{" "}
              <span className="text-zinc-300">ZEC</span>
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Price" value={`${fmtPrice(spotPrice(coin))} ZEC`} />
          <Stat label="In the curve" value={`${fmtZec(coin.realZat)} ZEC`} />
          <Stat label="Sold" value={fmtCoins(coin.sold)} />
          <Stat label="Holders" value={String(coin.holders)} />
        </div>

        <div>
          <div className="h-2 rounded bg-zinc-800 overflow-hidden">
            <div className="h-full bg-white" style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {progress.toFixed(1)}% of the 800M on the curve. There is no DEX to graduate to on Zcash: the curve
            stays the market, so a sell always fills.
          </p>
        </div>

        <PriceChart points={points} quoteSymbol="ZEC" />

        <div className="rounded-xl border border-zinc-800 bg-black p-4">
          <h2 className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-3">Trades</h2>
          {trades.length === 0 && <p className="text-sm text-zinc-600">No trades yet.</p>}
          <div className="space-y-1.5">
            {[...trades].reverse().slice(0, 30).map((t, i) => (
              <div key={`${t.txid}-${i}`} className="flex justify-between gap-3 text-xs font-mono">
                <span className={t.type === "buy" ? "text-white" : "text-zinc-500"}>{t.type.toUpperCase()}</span>
                <span className="text-zinc-400">{shortKey(t.holder)}</span>
                <span className="text-zinc-300">{fmtCoins(t.tokens)}</span>
                <span className="text-zinc-400">{fmtZec(t.zat)} ZEC</span>
                <span className="text-zinc-600">#{t.height}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-black p-4">
          <h2 className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-3">Holders</h2>
          <div className="space-y-1.5">
            {holders.slice(0, 20).map(([h, v]) => (
              <div key={h} className="flex justify-between text-xs font-mono">
                <span className="text-zinc-400">{shortKey(h)}{h === coin.creator && " · creator"}</span>
                <span className="text-zinc-300">{fmtCoins(v)} · {((Number(v) / Number(CURVE_SUPPLY)) * 80).toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="order-1 lg:order-2">
        <TradeBox coin={coin} state={state} />
      </div>
    </div>
  );
}

function TradeBox({ coin, state }: { coin: ZCoin; state: ZState }) {
  const { ready, secret, holder } = useHolderKey();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState(100);
  const [payout, setPayout] = useState("");

  useEffect(() => {
    try {
      setPayout(localStorage.getItem("notus.zcash.payout") ?? "");
    } catch {}
  }, []);

  const c = { vZat: BigInt(coin.vZat), vToken: BigInt(coin.vToken), realZat: BigInt(coin.realZat), sold: BigInt(coin.sold) };
  const balance = BigInt((holder && state.balances[coin.ticker]?.[holder]) || "0");
  const desk = state.desk.address;

  if (ready && !holder) return <NeedsHolderKey />;
  if (!desk || !holder || !secret) return null;

  const zatIn = parseZec(amount);
  const buyQ = zatIn > 0n ? quoteBuy(c, zatIn) : null;
  const sellAmount = (balance * BigInt(percent)) / 100n;
  const sellQ = sellAmount > 0n ? quoteSell(c, sellAmount) : null;
  const payoutOk = /^(utest1|ztestsapling1|tm|u1|zs1|t1)[0-9a-zA-Z]{20,400}$/.test(payout.trim());
  const nonce = BigInt(state.nonces[holder] ?? "0") + 1n;

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
                {v} ZEC
              </button>
            ))}
          </div>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0 ZEC" type="number" min="0" step="any"
            className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-sm focus:border-white outline-none text-right" />
          {buyQ && buyQ.tokensOut > 0n && (
            <>
              <p className="text-sm text-zinc-400">
                ≈ <span className="text-white">{fmtCoins(buyQ.tokensOut)}</span> ${coin.ticker}
                {buyQ.refund > 0n && <> · {fmtZec(buyQ.refund)} ZEC over the curve stays yours (claimable)</>}
              </p>
              <PaymentPanel
                address={desk}
                zat={zatIn}
                memo={memo.buy(coin.ticker, holder, (buyQ.tokensOut * 97n) / 100n)}
                title={`Buy $${coin.ticker}`}
                note="Coins are credited to your holder key. If the price moves more than 3% the ZEC is credited back to you instead."
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
          <input
            value={payout}
            onChange={(e) => {
              setPayout(e.target.value);
              try { localStorage.setItem("notus.zcash.payout", e.target.value.trim()); } catch {}
            }}
            placeholder="Your Zcash address — where the ZEC is paid"
            className="w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-xs font-mono focus:border-white outline-none placeholder:text-zinc-600"
          />
          {sellQ && payoutOk && (
            <>
              <p className="text-sm text-zinc-400">
                {fmtCoins(sellAmount)} ${coin.ticker} → <span className="text-white">{fmtZec(sellQ.net, 8)} ZEC</span>
              </p>
              <PaymentPanel
                address={desk}
                zat={DUST_ZAT}
                memo={memo.sell(secret, ZCASH_NETWORK, coin.ticker, sellAmount, (sellQ.net * 97n) / 100n, payout.trim(), nonce)}
                title={`Sell $${coin.ticker}`}
                note="The order is the signature inside the memo — the payment is only dust that carries it. The desk then pays your address."
              />
            </>
          )}
          {balance === 0n && <p className="text-sm text-zinc-600">Nothing to sell with this holder key.</p>}
          {balance > 0n && !payoutOk && <p className="text-xs text-zinc-600">Enter the address that should receive the ZEC.</p>}
        </>
      )}
      <p className="text-xs text-zinc-600">
        1% fee · {coin.feesToHolders ? "80% holder cashback" : "80% creator"} · 20% desk
      </p>
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
