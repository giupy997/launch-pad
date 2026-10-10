// Collect the garbage of the logo store (see lib/litecoin/logoGc.ts):
//   POST /api/ltc-logo/gc            with header x-gc-secret: $LOGO_GC_SECRET
//   POST /api/ltc-logo/gc?dry=1      only says what it would do
// Meant for a daily cron on the desk's machine. Off without LOGO_GC_SECRET.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { siteStore } from "@/lib/logoStore";
import { blobInfo, planGc, referencedLogoIds } from "@/lib/litecoin/logoGc";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const secret = process.env.LOGO_GC_SECRET;
  const given = req.headers.get("x-gc-secret") ?? "";
  if (!secret || secret.length < 16) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The live ledger, from the desk; without it nothing is collected (a missing state is not an empty one). */
async function ledger(): Promise<{ coins: { logo: string }[]; pending?: { memo: string | null }[] } | null> {
  const url = process.env.LTC_STATE_URL;
  if (!url) return null;
  try {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const s = (await r.json()) as { coins?: unknown; pending?: unknown };
    if (!Array.isArray(s.coins)) return null;
    return s as { coins: { logo: string }[]; pending?: { memo: string | null }[] };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "not authorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  const store = siteStore();
  if (!store) return NextResponse.json({ error: "no logo store on this site" }, { status: 503 });
  const state = await ledger();
  if (!state) return NextResponse.json({ error: "the ledger could not be read; nothing collected" }, { status: 503 });

  const now = Math.floor(Date.now() / 1000);
  const referenced = referencedLogoIds(state);
  const { blobs } = await store.list();
  const infos = [];
  for (const b of blobs) {
    const meta = await store.getMetadata(b.key);
    infos.push({ ...blobInfo(b.key, meta?.metadata), metadata: meta?.metadata ?? {} });
  }
  const plan = planGc(infos, referenced, now);

  if (!dry) {
    for (const key of plan.stamp) {
      const found = await store.getWithMetadata(key, { type: "arrayBuffer" });
      if (!found) continue;
      const type = typeof found.metadata?.type === "string" ? found.metadata.type : "image/webp";
      await store.set(key, new Blob([found.data], { type }), { metadata: { ...found.metadata, firstSeen: now } });
    }
    for (const key of plan.remove) await store.delete(key);
  }
  return NextResponse.json(
    { dry, scanned: blobs.length, referenced: referenced.size, removed: plan.remove, stamped: plan.stamp, kept: plan.keep.length },
    { headers: { "cache-control": "no-store" } }
  );
}
