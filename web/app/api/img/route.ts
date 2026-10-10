// Coin logos from other hosts, fetched by the site and served from here:
//   GET /api/img?u=https://…
// so the pages' Content-Security-Policy can name no image host but this
// one (a script that got in cannot beacon the wallet key out through an
// <img>), and visitors' browsers never call a logo's host themselves. Only
// public https hosts, no redirects, raster images under 2 MB, as the
// preview images already require; anything else is a 404 the <img> falls
// back from. Cached at the edge for a day.
import { NextResponse, type NextRequest } from "next/server";
import { fetchPublicImage } from "@/lib/safeFetch";
import { imageTypeOf } from "@/lib/imageType";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8_000;

const notFound = () => new NextResponse("not found", { status: 404, headers: { "cache-control": "public, max-age=300" } });

export async function GET(req: NextRequest) {
  const u = req.nextUrl.searchParams.get("u") ?? "";
  if (u.length > 2_000 || !/^https:\/\//i.test(u)) return notFound();
  const found = await fetchPublicImage(u, MAX_BYTES, TIMEOUT_MS);
  if (!found) return notFound();
  // the bytes say what the image is, whatever the host declared
  const type = imageTypeOf(found.bytes);
  if (!type) return notFound();
  return new NextResponse(new Blob([new Uint8Array(found.bytes)], { type }), {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      "netlify-cdn-cache-control": "public, s-maxage=604800, stale-while-revalidate=86400",
      "netlify-vary": "query", // the CDN's key leaves the query out by default: every logo would be the first one
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
