"use client";

import { CreateTokenForm } from "@/components/CreateTokenForm";
import { NotDeployedNotice } from "@/components/NotDeployedNotice";

export default function CreatePage() {
  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <NotDeployedNotice />
      {/* the head with its astrolabe, above the form */}
      <div className="relative hidden h-44 overflow-hidden rounded-2xl border border-white/10 card sm:block">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[url('/art/statue-orbit.webp')] bg-cover bg-[center_18%] opacity-90 mix-blend-screen"
        />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/90 via-transparent to-transparent" />
        <div className="absolute bottom-3 left-4 label">See the next rotation</div>
      </div>
      <section className="text-center space-y-3 py-4">
        <h1 className="font-mono text-2xl sm:text-3xl font-bold tracking-[0.15em] uppercase">
          Create a token
        </h1>
        <p className="text-zinc-400 max-w-xl mx-auto text-sm">
          One transaction deploys your coin, its bonding curve and — at
          graduation — a permanently locked liquidity pool.
        </p>
      </section>
      <CreateTokenForm />
    </div>
  );
}
