import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** The pages worth indexing: the launchpad's own, all static. A coin's page
 *  (/token/<address>) is reached from Explore and from links.
 *  Nothing here is read from the network, so the sitemap answers at once. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const page = (path: string, changeFrequency: "hourly" | "daily" | "weekly", priority: number) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency,
    priority,
  });
  return [
    page("/", "hourly", 1),
    page("/about", "weekly", 0.8),
    page("/create", "weekly", 0.7),
    page("/points", "daily", 0.6),
    page("/bridge", "weekly", 0.5),
    page("/swap", "weekly", 0.5),
    page("/profile", "weekly", 0.3),
  ];
}
