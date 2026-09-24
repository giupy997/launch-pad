"use client";

import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/ConnectButton";
import { HolderChip } from "@/components/zcash/HolderKey";
import { LtcWalletChip } from "@/components/litecoin/Wallet";

/** EVM chains connect a wallet; on Zcash a browser-made holder key owns the
 *  coins, on Litecoin a browser-made Litecoin wallet does. */
export function HeaderWallet() {
  const pathname = usePathname();
  if (pathname.startsWith("/zcash")) return <HolderChip />;
  if (pathname.startsWith("/litecoin")) return <LtcWalletChip />;
  return <ConnectButton />;
}
