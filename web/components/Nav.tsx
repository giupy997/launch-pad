"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Explore" },
  { href: "/create", label: "Create" },
  { href: "/swap", label: "Swap" },
  { href: "/bridge", label: "Bridge" },
  { href: "/profile", label: "Profile" },
];

const ZCASH_ITEMS = [
  { href: "/zcash", label: "Explore" },
  { href: "/zcash/create", label: "Deploy" },
  { href: "/zcash/wallet", label: "Wallet" },
  { href: "/zcash/ledger", label: "Ledger" },
];

export function Nav() {
  const pathname = usePathname();
  const onZcash = pathname.startsWith("/zcash");
  const items = onZcash ? ZCASH_ITEMS : ITEMS;
  const root = onZcash ? "/zcash" : "/";
  return (
    <nav className="hidden md:flex gap-0.5 sm:gap-1 font-mono text-[11px] sm:text-xs tracking-wider sm:tracking-widest uppercase overflow-x-auto no-scrollbar">
      {items.map((it) => {
        const active =
          it.href === root
            ? pathname === root || pathname.startsWith("/zcash/c/")
            : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`rounded-full px-2.5 sm:px-3.5 py-1.5 whitespace-nowrap transition-colors ${
              active
                ? "bg-white text-black"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
