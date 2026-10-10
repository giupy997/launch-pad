"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { base } from "@/lib/config";
import { useAppChain } from "@/lib/hooks";

/** The main menu; /bridge is "Get cbLTC" where the coins are quoted in it (Base), a bridge elsewhere. */
const items = (chainId: number) => [
  { href: "/", label: "Explore" },
  { href: "/create", label: "Create" },
  { href: "/points", label: "Points" },
  { href: "/bridge", label: chainId === base.id ? "Get cbLTC" : "Bridge" },
  { href: "/profile", label: "Profile" },
];

export function Nav() {
  const pathname = usePathname();
  const chain = useAppChain();
  const list = items(chain.id);
  return (
    <nav className="hidden md:flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.03] p-1 font-mono text-[11px] tracking-[0.18em] uppercase">
      {list.map((it) => {
        const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`rounded-full px-3.5 py-1.5 whitespace-nowrap transition-colors duration-150 ${
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
