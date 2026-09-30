// A coin logo the site stored for a Litecoin coin (see /api/ltc-logo):
// content-addressed, so it can be cached forever.
import { NextResponse, type NextRequest } from "next/server";
import { siteStore } from "@/lib/litecoin/logoStore";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{16}$/.test(id)) return new NextResponse("not found", { status: 404 });
  const store = siteStore();
  if (!store) return new NextResponse("not found", { status: 404 });
  const found = await store.getWithMetadata(id, { type: "arrayBuffer" });
  if (!found) return new NextResponse("not found", { status: 404 });
  const type = typeof found.metadata?.type === "string" && found.metadata.type.startsWith("image/") ? found.metadata.type : "image/webp";
  return new NextResponse(found.data, {
    headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}
