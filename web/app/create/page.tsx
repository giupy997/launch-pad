"use client";

import { CreateTokenForm } from "@/components/CreateTokenForm";
import { NotDeployedNotice } from "@/components/NotDeployedNotice";

export default function CreatePage() {
  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <NotDeployedNotice />
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
