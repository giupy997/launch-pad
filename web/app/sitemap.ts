import type { MetadataRoute } from "next";
import { readLedger, SITE_URL } from "@/lib/litecoin/server";

/** Rebuilt at most hourly, so new coins show up without a deploy. */
export const revalidate = 3600;

/** The pages worth indexing, plus one entry per coin on the Litecoin ledger. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const page = (path: string, changeFrequency: "hourly" | "daily" | "weekly", priority: number) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });
  const pages = [
    page("/", "hourly", 1),
    page("/litecoin", "hourly", 1),
    page("/litecoin/create", "weekly", 0.8),
    page("/litecoin/fund", "weekly", 0.6),
    page("/litecoin/wallet", "weekly", 0.5),
    page("/litecoin/ledger", "daily", 0.7),
    page("/about", "weekly", 0.8),
    page("/create", "weekly", 0.7),
    page("/swap", "weekly", 0.5),
    page("/bridge", "weekly", 0.5),
  ];
  const ledger = await readLedger();
  const coins = (ledger?.coins ?? []).map((c) => page(`/litecoin/c/${encodeURIComponent(c.ticker)}`, "hourly", 0.7));
  return [...pages, ...coins];
}
