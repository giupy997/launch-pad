"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Explore", icon: "◎" },
  { href: "/create", label: "Create", icon: "＋" },
  { href: "/swap", label: "Swap", icon: "⇅" },
  { href: "/bridge", label: "Bridge", icon: "⇄" },
  { href: "/profile", label: "Profile", icon: "◉" },
];

const ZCASH_ITEMS = [
  { href: "/zcash", label: "Explore", icon: "◎" },
  { href: "/zcash/create", label: "Deploy", icon: "＋" },
  { href: "/zcash/wallet", label: "Wallet", icon: "◉" },
  { href: "/zcash/ledger", label: "Ledger", icon: "≡" },
];

/** Mobile-only bottom navigation (the top nav is hidden below md). */
export function BottomNav() {
  const pathname = usePathname();
  const onZcash = pathname.startsWith("/zcash");
  const items = onZcash ? ZCASH_ITEMS : ITEMS;
  const root = onZcash ? "/zcash" : "/";
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 md:hidden border-t border-zinc-800 bg-black/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
      <div className="flex justify-around">
        {items.map((it) => {
          const active =
            it.href === root
              ? pathname === root || pathname.startsWith("/zcash/c/")
              : pathname.startsWith(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`flex flex-col items-center gap-0.5 px-3 py-2 min-w-16 ${
                active ? "text-white" : "text-zinc-500"
              }`}
            >
              <span className="text-base leading-none">{it.icon}</span>
              <span className="font-mono text-[9px] tracking-widest uppercase">{it.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
