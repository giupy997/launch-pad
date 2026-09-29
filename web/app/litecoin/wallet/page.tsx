"use client";

import Link from "next/link";
import { useState } from "react";
import { PARAMS, memo, spotPrice } from "@/lib/litecoin/ledger";
import { CARRY_LIT, DUST_LIT, evmAddressOfSecret, isAddress } from "@/lib/litecoin/tx";
import { LTC_NETWORK, fmtCoins, fmtLtc, parseLtc, txLink, useLitecoinState, useLtcWallet, useUtxos } from "@/lib/litecoin/client";
import { FundPanel, NeedsLtcWallet } from "@/components/litecoin/Wallet";
import { SendPanel } from "@/components/litecoin/SendPanel";
import { Copyable } from "@/components/litecoin/Copyable";
import { FrozenNotice } from "@/components/litecoin/FrozenNotice";
import { EvmDestination } from "@/components/litecoin/EvmDestination";

export default function LitecoinWallet() {
  const { data: state } = useLitecoinState();
  const { ready, kind, secret, wallet, address, ext, hasBrowserWallet, forget, disconnectExtension } = useLtcWallet();
  const extName = ext?.name ?? "the extension";
  const { balance } = useUtxos(address);
  const [reveal, setReveal] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [fund, setFund] = useState("");

  if (!ready) return null;
  if (!address) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <h1 className="display text-4xl text-white text-center">Wallet</h1>
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
  const myPending = (state?.pending ?? []).filter((p) => p.sender === address);
  const desk = state?.desk.address ?? null;
  const withdrawLit = parseLtc(amount);
  const withdrawOk = isAddress(to.trim(), LTC_NETWORK) && withdrawLit >= DUST_LIT;
  const fundLit = parseLtc(fund);

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <h1 className="display text-4xl text-white">Wallet</h1>

      <FundPanel address={address} />
      <p className="text-xs text-zinc-500 -mt-4">
        Holding ETH, BNB or stablecoins instead of LTC?{" "}
        <Link href="/litecoin/fund" className="underline text-zinc-300">Fund this wallet with a swap</Link>.
      </p>
      <FrozenNotice state={state} compact />

      <section className="card p-5 space-y-3">
        <div className="flex items-baseline justify-between">
          <Label>Claimable LTC — creator fees, holder cashback, refunds, carried dust</Label>
          <span className="font-mono text-lg">{fmtLtc(claimable, 8)}</span>
        </div>
        {claimable + CARRY_LIT < minPayout ? (
          <p className="text-xs text-zinc-600">Claims open from {fmtLtc(minPayout)} LTC — below that a network fee would eat it. It keeps accruing.</p>
        ) : !claiming ? (
          <button type="button" disabled={!desk} onClick={() => setClaiming(true)}
            className="btn-primary w-full py-2 text-sm">
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

      <EvmDestination state={state} />

      <section className="card p-5 space-y-3">
        <Label>Withdraw — send LTC from this wallet anywhere</Label>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Litecoin address"
          className="w-full rounded-lg input px-3 py-2 text-xs font-mono focus:border-white outline-none placeholder:text-zinc-600" />
        <div className="flex gap-2">
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0 LTC" type="number" min="0" step="any"
            className="flex-1 rounded-lg input px-3 py-2 text-sm focus:border-white outline-none text-right" />
          <button type="button" onClick={() => setAmount((Number(balance) / 1e8 - 0.0001).toFixed(8).replace(/\.?0+$/, ""))}
            className="rounded-full border border-white/15 px-3 text-xs text-zinc-300 hover:border-white">
            max
          </button>
        </div>
        {to.trim() && !isAddress(to.trim(), LTC_NETWORK) && <p className="text-xs text-zinc-500">⚠ Not a {LTC_NETWORK === "test" ? "testnet" : "mainnet"} Litecoin address.</p>}
        {withdrawOk && <SendPanel payments={[{ address: to.trim(), lit: withdrawLit }]} memo={null} title="Withdraw" confirmLabel="Sign & send" note="A plain Litecoin payment from your wallet." />}
      </section>

      <section className="card p-5 space-y-3">
        <Label>Fund the desk — LTC for its payout fees, owed to nobody</Label>
        <p className="text-xs text-zinc-600">
          A plain payment to the desk is credited back to whoever sent it. This one carries the <span className="font-mono">fund</span> instruction
          instead, so it becomes the desk&apos;s own money for the network fees of sells and claims. For the operator, or anyone who wants to chip in.
        </p>
        <input value={fund} onChange={(e) => setFund(e.target.value)} placeholder="0.0 LTC" type="number" min="0" step="any"
          className="w-full sm:w-48 rounded-lg input px-3 py-2 text-sm focus:border-white outline-none text-right" />
        {desk && fundLit >= DUST_LIT && (
          <SendPanel payments={[{ address: desk, lit: fundLit }]} memo={memo.fund()} title="Fund the desk" confirmLabel="Sign & fund"
            note="Goes to the desk's treasury, not to a claimable balance." />
        )}
      </section>

      {myPending.length > 0 && (
        <section>
          <Label>Waiting for a block</Label>
          <div className="space-y-1.5">
            {myPending.map((p) => (
              <a key={p.txid} href={txLink(p.txid)} target="_blank" rel="noreferrer" className="flex justify-between gap-3 text-xs font-mono hover:text-white">
                <span className="text-zinc-300 truncate">{p.memo ?? "(no memo)"}</span>
                <span className="text-zinc-500 shrink-0">{fmtLtc(p.valueLit)} LTC · pending</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section>
        <Label>Holdings</Label>
        {holdings.length === 0 && <p className="text-sm text-zinc-600">No coins yet. <Link href="/litecoin" className="underline">Explore</Link></p>}
        <div className="space-y-2">
          {holdings.map(({ coin, balance: bal }) => (
            <Link key={coin.ticker} href={`/litecoin/c/${coin.ticker}`} className="flex justify-between rounded-lg border border-white/10 px-4 py-3 text-sm hover:border-white">
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
              <Link key={c.ticker} href={`/litecoin/c/${c.ticker}`} className="rounded-full border border-white/15 px-3 py-1 text-xs font-mono hover:border-white">
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

      {kind === "hot" && secret && wallet ? (
        <section className="card p-5 space-y-3">
          <Label>Key — back it up; it cannot be recovered or reset</Label>
          {reveal ? (
            <>
              <Label>Secret (paste on another device to restore)</Label>
              <Copyable value={secret} />
              <Label>WIF (import into Electrum-LTC as p2wpkh:…)</Label>
              <Copyable value={`p2wpkh:${wallet.wif}`} />
              <Label>The same key on LitVM (EVM) — where these coins land unless another address is registered above</Label>
              <Copyable value={evmAddressOfSecret(secret)} />
              <p className="text-[11px] text-zinc-600">
                Litecoin and EVM chains share the same curve: import the secret above into MetaMask as a private key and this is your address there.
              </p>
            </>
          ) : (
            <button type="button" onClick={() => setReveal(true)} className="rounded-full border border-white/15 px-4 py-1.5 text-xs text-zinc-300 hover:border-white">
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
      ) : (
        <section className="card p-5 space-y-3">
          <Label>Connected with {extName} — its keys stay in the extension</Label>
          <p className="text-xs text-zinc-500">
            Every transaction here is built by the site and handed to {extName} to sign; the site never sees a key. Sells and
            claims are paid to this address.{hasBrowserWallet && ` Disconnecting brings back the wallet this browser keeps.`}
          </p>
          <button type="button" onClick={disconnectExtension} className="block text-xs text-zinc-400 underline">
            Disconnect {extName}
          </button>
        </section>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-1.5">{children}</div>;
}

