"use client";

import Link from "next/link";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { launchTokenAbi } from "@/lib/abi";
import { useTokens, spotPrice, useExplorer, useAppChain, isQuoteAsset } from "@/lib/hooks";
import { fmtEth, fmtTokens, shortAddr } from "@/lib/format";
import { TokenCard } from "@/components/TokenCard";
import { TokenLogo } from "@/components/TokenLogo";
import { CreatorFees } from "@/components/CreatorFees";

export default function ProfilePage() {
  const { address: user, isConnected } = useAccount();
  const { tokens } = useTokens();
  const explorer = useExplorer();
  const chainId = useAppChain().id;
  const { data: ethBal } = useBalance({ address: user, query: { enabled: !!user } });

  const { data: balances } = useReadContracts({
    contracts: tokens.map((t) => ({
      address: t.address,
      abi: launchTokenAbi,
      functionName: "balanceOf" as const,
      args: [user ?? "0x0000000000000000000000000000000000000000"] as const,
    })),
    query: { enabled: !!user && tokens.length > 0, refetchInterval: 5_000 },
  });

  if (!isConnected || !user) {
    return (
      <div className="text-center py-20 space-y-4">
      <div
        aria-hidden
        className="fixed inset-0 -z-10 pointer-events-none bg-[url('/profile-bg.jpg')] bg-cover bg-center opacity-25"
      />

        <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Profile</h1>
        <p className="text-zinc-500">Connect your wallet to see your tokens and holdings.</p>
      </div>
    );
  }

  // Pre-markets stay out of "created" (they're platform pair assets), but a
  // wallet that ends up holding one — e.g. from a graduation refund — still
  // sees it under holdings.
  const created = tokens.filter(
    (t) => t.curve.creator.toLowerCase() === user.toLowerCase() && !isQuoteAsset(chainId, t.address)
  );

  const holdings = tokens
    .map((t, i) => {
      const b = balances?.[i];
      const balance = b?.status === "success" ? (b.result as bigint) : 0n;
      return { token: t, balance };
    })
    .filter((h) => h.balance > 0n)
    .map((h) => ({
      ...h,
      // rough value estimate at spot price (ignores curve impact and fees)
      value: (h.balance * spotPrice(h.token.curve)) / 10n ** 18n,
    }));

  return (
    <div className="space-y-12">
      <div
        aria-hidden
        className="fixed inset-0 -z-10 pointer-events-none bg-[url('/profile-bg.jpg')] bg-cover bg-center opacity-25"
      />

      <section className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-[0.15em] uppercase">Profile</h1>
          <p className="mt-1 font-mono text-sm text-zinc-400">
            <a href={`${explorer}/address/${user}`} target="_blank" className="underline">
              {shortAddr(user)}
            </a>
          </p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <div className="rounded-xl border border-zinc-800 px-5 py-3">
            <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
              Balance
            </div>
            <div className="mt-0.5 font-semibold">
              {ethBal ? `${fmtEth(ethBal.value)} ETH` : "…"}
            </div>
          </div>
          <CreatorFees />
        </div>
      </section>

      <section>
        <h2 className="font-mono text-sm font-semibold tracking-[0.2em] uppercase mb-4 text-zinc-400">
          Holdings {holdings.length > 0 && <span className="text-zinc-600">({holdings.length})</span>}
        </h2>
        {holdings.length === 0 && (
          <p className="text-zinc-500 text-sm">
            No launchpad tokens yet.{" "}
            <Link href="/" className="underline hover:text-white">
              Explore tokens
            </Link>
          </p>
        )}
        <div className="space-y-2">
          {holdings.map(({ token: t, balance, value }) => (
            <Link
              key={t.address}
              href={`/token/${t.address}`}
              className="flex items-center gap-4 rounded-xl border border-zinc-800 p-3 hover:border-white transition-colors"
            >
              <TokenLogo uri={t.meta.logoURI} symbol={t.symbol} size={40} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">
                  {t.name} <span className="font-mono text-xs text-zinc-400">${t.symbol}</span>
                </div>
                <div className="text-xs text-zinc-500">
                  {t.curve.graduated ? "graduated" : "on curve"}
                </div>
              </div>
              <div className="text-right">
                <div className="font-semibold text-sm">{fmtTokens(balance)}</div>
                <div className="text-xs text-zinc-500">≈ {fmtEth(value)} ETH</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section>
        <h2 className="font-mono text-sm font-semibold tracking-[0.2em] uppercase mb-4 text-zinc-400">
          Created by you {created.length > 0 && <span className="text-zinc-600">({created.length})</span>}
        </h2>
        {created.length === 0 && (
          <p className="text-zinc-500 text-sm">
            You haven&apos;t launched any token.{" "}
            <Link href="/create" className="underline hover:text-white">
              Create one
            </Link>
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {created.map((t) => (
            <TokenCard key={t.address} token={t} />
          ))}
        </div>
      </section>
    </div>
  );
}
