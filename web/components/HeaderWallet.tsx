"use client";

import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/ConnectButton";
import { HolderChip } from "@/components/zcash/HolderKey";

/** EVM chains connect a wallet; on Zcash a browser-made holder key owns the coins. */
export function HeaderWallet() {
  return usePathname().startsWith("/zcash") ? <HolderChip /> : <ConnectButton />;
}
