import type { Metadata } from "next";
import { LegacyPage } from "./LegacyPage";

export const metadata: Metadata = {
  title: "Legacy",
  description:
    "The launchpads Notus moved on from, per chain: their coins as they stand, a sell box for the ones still on their curve, the cashback and creator fees still claimable there, and the links to their pools.",
};

export default function Page() {
  return <LegacyPage />;
}
