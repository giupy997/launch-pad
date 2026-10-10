import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Litecoin",
  description:
    "Launch and trade coins on Litecoin itself: an OP_RETURN ledger, a bonding curve, a locked pool with no price ceiling. Every coin migrates to LitVM automatically at mainnet.",
};

export default function LitecoinLayout({ children }: { children: React.ReactNode }) {
  return children;
}
