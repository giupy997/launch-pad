// A coin logo the site stored itself (coins migrated onto the pads still
// name it in their metadata): content-addressed, so it can be cached forever.
import { NextResponse, type NextRequest } from "next/server";
import { siteStore } from "@/lib/logoStore";
import { imageTypeOf } from "@/lib/imageType";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{16}$/.test(id)) return new NextResponse("not found", { status: 404 });
  const store = siteStore();
  if (!store) return new NextResponse("not found", { status: 404 });
  const found = await store.getWithMetadata(id, { type: "arrayBuffer" });
  if (!found) return new NextResponse("not found", { status: 404 });
  // the bytes say what the image is, whatever the store's metadata says: a raster image or
  // nothing (an SVG would run script under this origin if ever written to the store)
  const type = imageTypeOf(new Uint8Array(found.data));
  if (!type) return new NextResponse("not found", { status: 404 });
  return new NextResponse(found.data, {
    headers: {
      "content-type": type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
