import type { Metadata } from "next";
import { PointsPage } from "./PointsPage";

export const metadata: Metadata = {
  title: "Points",
  description:
    "A season-based record of what every wallet does on the Notus launchpad on LitVM: 20 points per LTC traded, more for graduations and invites. A public leaderboard. Rehearsed on the Liteforge testnet.",
};

export default function Page() {
  return <PointsPage />;
}
