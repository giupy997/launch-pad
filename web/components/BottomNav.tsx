"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { base } from "@/lib/config";
import { useAppChain } from "@/lib/hooks";

const items = (chainId: number) => [
  { href: "/", label: "Explore", icon: "◎" },
  { href: "/create", label: "Create", icon: "＋" },
  chainId === base.id ? { href: "/bridge", label: "cbLTC", icon: "Ł" } : { href: "/bridge", label: "Bridge", icon: "⇄" },
  { href: "/profile", label: "Profile", icon: "◉" },
];

const sectionItems = (root: string) =>
  root === "/litecoin"
    ? [
        // closed: only the wallet (withdraw, claim) and the ledger stay
        { href: `${root}/wallet`, label: "Wallet", icon: "◉" },
        { href: `${root}/ledger`, label: "Ledger", icon: "≡" },
      ]
    : [
        { href: root, label: "Explore", icon: "◎" },
        { href: `${root}/create`, label: "Deploy", icon: "＋" },
        { href: `${root}/wallet`, label: "Wallet", icon: "◉" },
        { href: `${root}/ledger`, label: "Ledger", icon: "≡" },
      ];
const SECTIONS = ["/zcash", "/litecoin"];

/** Mobile-only bottom navigation (the top nav is hidden below md). */
export function BottomNav() {
  const pathname = usePathname();
  const chain = useAppChain();
  const section = SECTIONS.find((p) => pathname.startsWith(p));
  const list = section ? sectionItems(section) : items(chain.id);
  const root = section && list.some((it) => it.href === section) ? section : section ? "" : "/";
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 md:hidden glass border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]">
      <div className="flex justify-around">
        {list.map((it) => {
          const active =
            it.href === root
              ? pathname === root || pathname.startsWith(`${root}/c/`)
              : pathname.startsWith(it.href);
          return (
            <Link
              key={it.href}
              href={it.href}
              className={`relative flex flex-col items-center gap-0.5 px-3 py-2.5 min-w-16 transition-colors ${
                active ? "text-white" : "text-zinc-500"
              }`}
            >
              {active && <span className="absolute top-0 h-px w-8 bg-gradient-to-r from-transparent via-white to-transparent" />}
              <span className="text-base leading-none">{it.icon}</span>
              <span className="font-mono text-[9px] tracking-widest uppercase">{it.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
