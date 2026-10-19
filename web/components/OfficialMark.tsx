"use client";

import { isOfficialToken } from "@/lib/config";
import { useAppChain } from "@/lib/hooks";

/** "Official" beside a coin's name when its address is in OFFICIAL_TOKENS for
 *  the app's chain (lib/config.ts): the project's own coins, told apart from
 *  any coin that borrows their name or ticker. Nothing on every other coin. */
export function OfficialMark({ token, size = "xs" }: { token: string; size?: "xs" | "sm" }) {
  const chain = useAppChain();
  if (!isOfficialToken(chain.id, token)) return null;
  return (
    <span
      title="A coin of the Notus project itself: its address is in the site's list of official coins"
      className={`shrink-0 rounded-full bg-white font-mono tracking-widest uppercase text-black ${
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-1.5 py-px text-[9px]"
      }`}
    >
      ★ Official
    </span>
  );
}
