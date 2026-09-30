import Link from "next/link";

/** Notus on Litecoin has closed: its coins were all sold back, and coins now
 *  launch on cbLTC. The wallet and ledger pages stay for whoever has LTC in
 *  a browser wallet or a claim to collect; explore and deploy are gone. */
export function ClosedNotice() {
  return (
    <div className="rounded-xl border border-white/30 bg-black p-4 text-sm space-y-1">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">Notus on Litecoin has closed</div>
      <p className="text-zinc-300">
        No coin trades on this ledger any more. If this browser holds a Litecoin wallet, withdraw its LTC below to any address of
        yours; claims are still paid. Coins now launch priced in cbLTC:{" "}
        <Link href="/" className="underline hover:text-white">
          open Notus
        </Link>
        .
      </p>
    </div>
  );
}
