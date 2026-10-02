// The browser's road to the points service (a VPS running `node
// points/service.ts`, behind Caddy), when POINTS_URL is set. Same-origin, so
// the pages need no CORS; only the service's own routes pass; reads are
// cached half a minute at the edge, an invite's acceptance goes straight
// through with the visitor's address for the service's rate limit.
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const BASE = process.env.POINTS_URL?.replace(/\/$/, "");
const ALLOWED = /^(health|[a-z0-9-]+\/(season|leaderboard|wallet\/0x[0-9a-fA-F]{40}|referral))$/;
const MAX_BODY = 4_096;

const cache = (seconds: number): Record<string, string> =>
  seconds === 0
    ? { "cache-control": "no-store" }
    : {
        "cache-control": `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
        "netlify-cdn-cache-control": `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 4}`,
      };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: cache(0) });

function clientIp(req: NextRequest): string {
  const nf = req.headers.get("x-nf-client-connection-ip");
  if (nf) return nf;
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "?";
}

async function proxy(req: NextRequest, path: string[]) {
  const p = path.join("/");
  if (!BASE) return json({ error: "POINTS_URL not set" }, 404);
  if (!ALLOWED.test(p)) return json({ error: "not found" }, 404);
  const isPost = req.method === "POST";
  if (isPost !== p.endsWith("/referral")) return json({ error: "method not allowed" }, 405);

  const url = new URL(`${BASE}/${p}`);
  if (!isPost) {
    const limit = req.nextUrl.searchParams.get("limit");
    if (limit && /^\d{1,3}$/.test(limit)) url.searchParams.set("limit", limit);
  }
  const headers: Record<string, string> = { accept: "application/json", "x-forwarded-for": clientIp(req) };
  const init: RequestInit = { method: req.method, headers, cache: "no-store", signal: AbortSignal.timeout(8_000) };
  if (isPost) {
    const body = await req.text();
    if (body.length > MAX_BODY) return json({ error: "too large" }, 413);
    headers["content-type"] = "application/json";
    init.body = body;
  }
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    const seconds = !isPost && r.status === 200 && p !== "health" ? 30 : 0;
    return new NextResponse(text, { status: r.status, headers: { "content-type": "application/json", ...cache(seconds) } });
  } catch (e) {
    return json({ error: `points service unreachable: ${(e as Error).message}` }, 502);
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
