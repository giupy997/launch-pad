"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Explore" },
  { href: "/create", label: "Create" },
  { href: "/bridge", label: "Get cbLTC" },
  { href: "/profile", label: "Profile" },
];

// The contract-less networks (Zcash, Litecoin) each have their own section of the site.
const SECTIONS: Record<string, { href: string; label: string }[]> = {
  "/zcash": [
    { href: "/zcash", label: "Explore" },
    { href: "/zcash/create", label: "Deploy" },
    { href: "/zcash/wallet", label: "Wallet" },
    { href: "/zcash/ledger", label: "Ledger" },
  ],
  "/litecoin": [
    { href: "/litecoin", label: "Explore" },
    { href: "/litecoin/create", label: "Deploy" },
    { href: "/litecoin/wallet", label: "Wallet" },
    { href: "/litecoin/ledger", label: "Ledger" },
  ],
};

export function Nav() {
  const pathname = usePathname();
  const section = Object.keys(SECTIONS).find((p) => pathname.startsWith(p));
  const items = section ? SECTIONS[section] : ITEMS;
  const root = section ?? "/";
  return (
    <nav className="hidden md:flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-1 font-mono text-[11px] tracking-[0.18em] uppercase">
      {items.map((it) => {
        const active =
          it.href === root
            ? pathname === root || pathname.startsWith(`${root}/c/`)
            : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`rounded-full px-3.5 py-1.5 whitespace-nowrap transition-all duration-200 ${
              active
                ? "bg-white text-black shadow-[0_0_20px_-6px_rgba(255,255,255,0.6)]"
                : "text-zinc-400 hover:text-white hover:bg-white/[0.06]"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
