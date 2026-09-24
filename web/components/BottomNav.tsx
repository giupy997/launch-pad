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

const sectionItems = (root: string) => [
  { href: root, label: "Explore", icon: "◎" },
  { href: `${root}/create`, label: "Deploy", icon: "＋" },
  { href: `${root}/wallet`, label: "Wallet", icon: "◉" },
  { href: `${root}/ledger`, label: "Ledger", icon: "≡" },
];
const SECTIONS = ["/zcash", "/litecoin"];

/** Mobile-only bottom navigation (the top nav is hidden below md). */
export function BottomNav() {
  const pathname = usePathname();
  const section = SECTIONS.find((p) => pathname.startsWith(p));
  const items = section ? sectionItems(section) : ITEMS;
  const root = section ?? "/";
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 md:hidden border-t border-zinc-800 bg-black/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
      <div className="flex justify-around">
        {items.map((it) => {
          const active =
            it.href === root
              ? pathname === root || pathname.startsWith(`${root}/c/`)
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
