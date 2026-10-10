"use client";

import { ConnectButton } from "@/components/ConnectButton";

/** The header's wallet slot: every pad is on an EVM chain, so a connected wallet owns the coins. */
export function HeaderWallet() {
  return <ConnectButton />;
}
