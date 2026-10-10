"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { base } from "@/lib/config";
import { useAppChain } from "@/lib/hooks";

const items = (chainId: number) => [
  { href: "/", label: "Explore", icon: "◎" },
  { href: "/create", label: "Create", icon: "＋" },
  { href: "/points", label: "Points", icon: "✦" },
  chainId === base.id ? { href: "/bridge", label: "cbLTC", icon: "Ł" } : { href: "/bridge", label: "Bridge", icon: "⇄" },
  { href: "/profile", label: "Profile", icon: "◉" },
];

/** Mobile-only bottom navigation (the top nav is hidden below md). */
export function BottomNav() {
  const pathname = usePathname();
  const chain = useAppChain();
  const list = items(chain.id);
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 md:hidden glass border-x-0 border-b-0 pb-[env(safe-area-inset-bottom)]">
      <div className="flex justify-around">
        {list.map((it) => {
          const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
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
