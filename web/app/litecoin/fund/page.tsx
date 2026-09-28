"use client";

import Link from "next/link";
import { LTC_NETWORK, useLtcWallet } from "@/lib/litecoin/client";
import { FundPanel, NeedsLtcWallet } from "@/components/litecoin/Wallet";
import { Copyable } from "@/components/litecoin/Copyable";

/** Litecoin has no bridge from Ethereum or BNB Chain: what exists are swap
 *  services that take ETH or BNB and pay LTC straight to an address. The
 *  page hands the wallet's address over and opens the service on the pair. */
const PROVIDERS = [
  {
    name: "SideShift",
    note: "no account, direct to your address, ~10 min",
    pairs: [
      { from: "ETH", href: "https://sideshift.ai/eth/ltc" },
      { from: "BNB", href: "https://sideshift.ai/bnb/ltc" },
      { from: "USDT", href: "https://sideshift.ai/usdt/ltc" },
    ],
  },
  {
    name: "ChangeNOW",
    note: "no account, fixed or floating rate",
    pairs: [
      { from: "ETH", href: "https://changenow.io/exchange?from=eth&to=ltc&amount=0.1" },
      { from: "BNB", href: "https://changenow.io/exchange?from=bnbbsc&to=ltc&amount=0.5" },
      { from: "USDT", href: "https://changenow.io/exchange?from=usdterc20&to=ltc&amount=100" },
    ],
  },
  {
    name: "THORSwap",
    note: "decentralised (THORChain), from your own wallet",
    pairs: [
      { from: "ETH", href: "https://app.thorswap.finance/swap/ETH.ETH_LTC.LTC" },
      { from: "BNB", href: "https://app.thorswap.finance/swap/BSC.BNB_LTC.LTC" },
    ],
  },
];

export default function FundPage() {
  const { ready, address } = useLtcWallet();
  if (ready && !address) return <NeedsLtcWallet />;
  if (!address) return null;
  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Fund your wallet</h1>
        <p className="mt-2 text-sm text-zinc-500">
          Everything here is paid in LTC. If you hold ETH, BNB or stablecoins instead, a swap service turns them into LTC
          and pays this wallet directly: pick a service, choose what you send, and paste this address as the receiving
          address. The LTC shows up here after a couple of Litecoin blocks.
        </p>
      </div>

      <section className="space-y-2">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Step 1 · your receiving address</div>
        <Copyable label={LTC_NETWORK === "main" ? "LTC" : "tLTC"} value={address} />
        <FundPanel address={address} compact />
      </section>

      <section className="space-y-3">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Step 2 · swap to LTC</div>
        {LTC_NETWORK === "test" && (
          <p className="rounded-xl border border-dashed border-zinc-700 p-3 text-xs text-zinc-400">
            This is the Litecoin testnet: swap services pay mainnet LTC only. Use a testnet faucet instead.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          {PROVIDERS.map((p) => (
            <div key={p.name} className="rounded-xl border border-zinc-800 bg-black p-4 space-y-3">
              <div>
                <div className="font-semibold">{p.name}</div>
                <div className="text-[11px] text-zinc-500">{p.note}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                {p.pairs.map((x) => (
                  <a
                    key={x.from}
                    href={x.href}
                    target="_blank"
                    rel="noreferrer noopener nofollow"
                    className="rounded-full border border-zinc-700 px-3 py-1 font-mono text-xs text-zinc-300 hover:border-white hover:text-white"
                  >
                    {x.from} → LTC
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-zinc-600">
          These are third-party services, not part of Notus: check the rate they quote, and send only to the deposit address
          they show you. Anything you receive here is yours alone — this wallet&apos;s key never leaves your browser.
        </p>
      </section>

      <section className="space-y-2">
        <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Step 3 · trade</div>
        <p className="text-sm text-zinc-400">
          With LTC in the wallet, every coin on <Link href="/litecoin" className="underline">Explore</Link> is one click away, and
          your own coin one <Link href="/litecoin/create" className="underline">deploy</Link>.
        </p>
      </section>
    </div>
  );
}
