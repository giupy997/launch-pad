"use client";

import { useEffect, useState } from "react";
import { CURVE_SUPPLY, MEMO_MAX_BYTES, PARAMS, TOTAL_SUPPLY, memo, memoBytes, normalizeLink, quoteBuy, quoteSell, spotPrice, type CoinLinks } from "@/lib/litecoin/ledger";
import { CARRY_LIT } from "@/lib/litecoin/tx";
import { LTC_NETWORK, addressLink, curveOf, fmtCoins, fmtLtc, fmtMcap, fmtPrice, marketCapLtc, parseLtc, shortAddr, txLink, useLitecoinState, useLtcPrice, useLtcWallet, type LCoin, type LState } from "@/lib/litecoin/client";
import { SendPanel } from "@/components/litecoin/SendPanel";
import { NeedsLtcWallet } from "@/components/litecoin/Wallet";
import { TokenLogo } from "@/components/TokenLogo";
import { Copyable } from "@/components/litecoin/Copyable";
import { LogoUpload } from "@/components/litecoin/LogoUpload";
import { FrozenNotice } from "@/components/litecoin/FrozenNotice";
import { PriceChart } from "@/components/PriceChart";

const URL_OK = /^(https?:\/\/|ipfs:\/\/)\S{1,300}$/;

export default function LitecoinCoinPage({ params }: { params: { ticker: string } }) {
  const ticker = decodeURIComponent(params.ticker).toUpperCase();
  const { data: state, isLoading } = useLitecoinState();
  const usd = useLtcPrice().data?.usd ?? null;
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
  const held = coin.graduated ? TOTAL_SUPPLY - BigInt(coin.poolToken) : BigInt(coin.sold);
  const trades = state.trades.filter((t) => t.ticker === ticker);
  // each trade's average price, as a market cap: LTC per coin × 1B, in dollars when the LTC price is known
  const mcapOf = (ltcPerCoin: number) => ltcPerCoin * 1_000_000_000 * (usd ?? 1);
  const points = trades.filter((t) => t.tokens !== "0").map((t) => mcapOf(Number(t.lit) / Number(t.tokens)));
  const mcap = marketCapLtc(coin);
  const holders = Object.entries(state.balances[ticker] ?? {}).sort((a, b) => (BigInt(b[1]) > BigInt(a[1]) ? 1 : -1));

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6 order-2 lg:order-1">
        <div className="flex items-start gap-4">
          <TokenLogo uri={coin.logo} symbol={coin.ticker} size={72} />
          <div>
            <h1 className="text-3xl font-bold">
              {coin.name} <span className="font-mono text-lg text-zinc-400">${coin.ticker}</span>
              {coin.graduated && (
                <span className="ml-3 font-mono text-xs tracking-widest uppercase bg-white text-black rounded-full px-2 py-0.5 align-middle">
                  Graduated
                </span>
              )}
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
            {coin.links && (coin.links.web || coin.links.x || coin.links.tg) && (
              <p className="mt-1 flex flex-wrap gap-x-3 text-sm text-zinc-400">
                {coin.links.web && (
                  <a href={/^https?:\/\//i.test(coin.links.web) ? coin.links.web : `https://${coin.links.web}`} target="_blank" rel="noreferrer nofollow" className="underline hover:text-white">
                    {coin.links.web.replace(/^https?:\/\//i, "")}
                  </a>
                )}
                {coin.links.x && (
                  <a href={`https://x.com/${coin.links.x}`} target="_blank" rel="noreferrer nofollow" className="underline hover:text-white">
                    x.com/{coin.links.x}
                  </a>
                )}
                {coin.links.tg && (
                  <a href={`https://t.me/${coin.links.tg}`} target="_blank" rel="noreferrer nofollow" className="underline hover:text-white">
                    t.me/{coin.links.tg}
                  </a>
                )}
              </p>
            )}
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
              <Copyable label="link" value={`${typeof window === "undefined" ? "" : window.location.origin}/litecoin/c/${coin.ticker}`} />
              <Copyable label="coin id" value={coin.txid} />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Market cap" value={fmtMcap(mcap, usd)} sub={`${usd ? `${mcap.toFixed(2)} LTC · ` : ""}${fmtPrice(spotPrice(coin))} LTC per coin`} />
          <Stat label={coin.graduated ? "In the pool" : "In the curve"} value={`${fmtLtc(coin.graduated ? coin.poolLit : coin.realLit)} LTC`} />
          <Stat label={coin.graduated ? "Held" : "Sold"} value={fmtCoins(held)} />
          <Stat label="Holders" value={String(coin.holders)} />
        </div>

        <div>
          <div className="h-2 rounded bg-zinc-800 overflow-hidden">
            <div className="h-full bg-white" style={{ width: `${Math.min(progress, 100)}%` }} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {coin.graduated ? (
              <>
                Graduated: the 800M sold out, and the LTC raised plus the 200M reserve became a pool locked inside the
                ledger ({fmtLtc(coin.poolLit)} LTC · {fmtCoins(coin.poolToken)} ${coin.ticker}). The price floats freely from here — no
                ceiling — and a sell always fills. When LitVM mainnet goes live the coin migrates there automatically,
                and this pool moves to a DEX as is.
              </>
            ) : (
              <>
                {progress.toFixed(1)}% of the 800M on the curve. At 800M the coin graduates: the LTC raised and the 200M
                reserve become a locked pool, and the price keeps going with no ceiling. A sell always fills. When LitVM
                mainnet goes live the coin migrates there automatically — same holders, same price.
              </>
            )}
          </p>
        </div>

        <PriceChart points={points} label="Market cap" format={(v) => (usd ? fmtMcap(v / usd, usd) : fmtMcap(v, null))} />

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
                <span className="text-zinc-300">{fmtCoins(v)} · {((Number(v) / Number(TOTAL_SUPPLY)) * 100).toFixed(2)}%</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="order-1 lg:order-2 space-y-4">
        {state.freezeHeight ? (
          <FrozenNotice state={state} ticker={coin.ticker} />
        ) : (
          <>
            <TradeBox coin={coin} state={state} />
            <CreatorPanel coin={coin} state={state} />
            <LinksPanel coin={coin} state={state} />
          </>
        )}
      </div>
    </div>
  );
}

function TradeBox({ coin, state }: { coin: LCoin; state: LState }) {
  const { ready, address } = useLtcWallet();
  const [mode, setMode] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState(100);

  const c = curveOf(coin);
  const balance = BigInt((address && state.balances[coin.ticker]?.[address]) || "0");
  const desk = state.desk.address;

  if (ready && !address) return <NeedsLtcWallet />;
  if (!desk || !address) return null;

  const litIn = parseLtc(amount);
  const buyQ = litIn > 0n ? quoteBuy(c, litIn) : null;
  const sellAmount = (balance * BigInt(percent)) / 100n;
  const sellQ = sellAmount > 0n ? quoteSell(c, sellAmount) : null;
  // The desk only pays out from minPayoutLit (a network fee would eat less):
  // the ledger refuses smaller sells, so do not let one be signed.
  const minPayout = PARAMS[LTC_NETWORK].minPayoutLit;
  const tooSmall = !!sellQ && sellQ.net < minPayout;
  let minPercent: number | null = null;
  if (tooSmall) {
    for (let p = percent + 1; p <= 100; p++) {
      if (quoteSell(c, (balance * BigInt(p)) / 100n).net >= minPayout) {
        minPercent = p;
        break;
      }
    }
  }

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
          {buyQ && buyQ.tokensOut === 0n && <p className="text-sm text-zinc-500">Too small to buy anything at this price.</p>}
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
          {sellQ && tooSmall && (
            <p className="text-xs text-zinc-400">
              ⚠ {fmtCoins(sellAmount)} ${coin.ticker} would pay {fmtLtc(sellQ.net, 8)} LTC, below the {fmtLtc(minPayout)} LTC the desk pays out
              (a network fee would eat less; the ledger refuses it).{" "}
              {minPercent !== null ? (
                <>
                  Sell at least{" "}
                  <button type="button" onClick={() => setPercent(minPercent!)} className="underline text-zinc-200">
                    {minPercent}%
                  </button>
                  .
                </>
              ) : (
                "Your whole balance is under the minimum right now — it clears once the price rises."
              )}
            </p>
          )}
          {sellQ && !tooSmall && (
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
          <LogoUpload name={coin.ticker} onUploaded={setUrl} />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="…or paste an image URL: https://… or ipfs://… (square image)" type="url"
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

/** The creator sets X, Telegram and website in one instruction (only the
 *  fields that change are sent; an empty field clears). Prefilled from the
 *  deploy page's query string when it comes from there. */
function LinksPanel({ coin, state }: { coin: LCoin; state: LState }) {
  const { address } = useLtcWallet();
  const [open, setOpen] = useState(false);
  const [x, setX] = useState(coin.links?.x ?? "");
  const [tg, setTg] = useState(coin.links?.tg ?? "");
  const [web, setWeb] = useState(coin.links?.web ?? "");
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.has("x") || q.has("tg") || q.has("web")) {
      setX(q.get("x") ?? "");
      setTg(q.get("tg") ?? "");
      setWeb(q.get("web") ?? "");
      setOpen(true);
    }
  }, []);
  const desk = state.desk.address;
  if (!address || !desk || address !== coin.creator) return null;
  const norm = { x: normalizeLink("x", x), tg: normalizeLink("tg", tg), web: normalizeLink("web", web) };
  const bad = (["x", "tg", "web"] as const).filter((k) => norm[k] === null);
  const changes: CoinLinks = {};
  for (const k of ["x", "tg", "web"] as const) {
    const v = norm[k];
    if (v !== null && v !== (coin.links?.[k] ?? "")) changes[k] = v;
  }
  const m = memo.links(coin.ticker, changes);
  const ok = bad.length === 0 && Object.keys(changes).length > 0 && memoBytes(m) <= MEMO_MAX_BYTES;
  const has = !!(coin.links?.x || coin.links?.tg || coin.links?.web);
  const inputCls = "w-full rounded-lg bg-black border border-zinc-700 px-3 py-2 text-xs font-mono focus:border-white outline-none placeholder:text-zinc-600";
  return (
    <div className="rounded-xl border border-zinc-800 bg-black p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Creator · links</span>
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs text-zinc-400 underline">
          {open ? "close" : has ? "change" : "set X, Telegram, website"}
        </button>
      </div>
      {open && (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <input value={x} onChange={(e) => setX(e.target.value)} placeholder="X · @handle" className={inputCls} />
            <input value={tg} onChange={(e) => setTg(e.target.value)} placeholder="Telegram · @handle" className={inputCls} />
            <input value={web} onChange={(e) => setWeb(e.target.value)} placeholder="Website · https://…" className={inputCls} />
          </div>
          {bad.length > 0 && <p className="text-[11px] text-zinc-500">⚠ {bad.join(", ")}: handles are letters, digits and _ (no URL), the website a plain address.</p>}
          {bad.length === 0 && Object.keys(changes).length === 0 && <p className="text-[11px] text-zinc-500">Nothing changed. Clear a field to remove that link.</p>}
          {bad.length === 0 && Object.keys(changes).length > 0 && memoBytes(m) > MEMO_MAX_BYTES && (
            <p className="text-[11px] text-zinc-500">⚠ {memoBytes(m)}/{MEMO_MAX_BYTES} bytes — shorten the website, or send the links in two transactions.</p>
          )}
          {ok && (
            <SendPanel payments={[{ address: desk, lit: CARRY_LIT }]} memo={m} title={`Set $${coin.ticker} links`}
              note="Only a transaction paid from the creator address changes the links; the dust is credited back." />
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-black p-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-sm">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-zinc-600 truncate" title={sub}>{sub}</div>}
    </div>
  );
}
