import { ImageResponse } from "next/og";
import { readCoin, SITE_URL } from "@/lib/litecoin/server";
import { spotPrice } from "@/lib/litecoin/ledger";
import { siteStore } from "@/lib/litecoin/logoStore";
import { siteLogoId } from "@/lib/site";
import { fetchPublicImage } from "@/lib/litecoin/safeFetch";
import { tickerFromParam } from "@/lib/litecoin/client";

/** A preview is a picture of a moment: minutes at the edge, not a year. */
const CACHE = { "cache-control": "public, max-age=300, s-maxage=900, stale-while-revalidate=3600" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "A coin on Notus";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fmtM = (units: string) => `${(Number(units) / 1e8 / 1e6).toFixed(2)}M`;

async function readOwnLogo(id: string): Promise<string | null> {
  try {
    const store = siteStore();
    const found = store ? await store.getWithMetadata(id, { type: "arrayBuffer" }) : null;
    if (!found) return null;
    const type = typeof found.metadata?.type === "string" && found.metadata.type.startsWith("image/") ? found.metadata.type : "image/webp";
    return `data:${type};base64,${Buffer.from(found.data).toString("base64")}`;
  } catch {
    return null;
  }
}

export default async function Image({ params }: { params: { ticker: string } }) {
  const ticker = tickerFromParam(params.ticker);
  if (!ticker) return new Response("not found", { status: 404 });
  const [found, regular, bold] = await Promise.all([
    readCoin(ticker),
    fetch(`${SITE_URL}/fonts/Geist-Regular.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer()),
    fetch(`${SITE_URL}/fonts/Geist-Bold.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer()),
  ]);
  const coin = found?.coin;
  const capLtc = coin ? spotPrice(coin) * 1_000_000_000 : 0;
  const cap = capLtc >= 100 ? capLtc.toFixed(0) : capLtc.toFixed(2);
  // a logo the site stored itself is read straight from the store (whatever
  // hostname the ledger recorded for it); anything else is fetched here, so a
  // logo host that is slow or down costs the letter, not the whole card
  const own = coin?.logo ? siteLogoId(coin.logo) : null;
  const logoUrl = own ? null : coin?.logo && /^https?:\/\//.test(coin.logo) ? coin.logo : coin?.logo?.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${coin.logo.slice(7)}` : null;
  const logo = own
    ? await readOwnLogo(own)
    : logoUrl
    ? await fetchPublicImage(logoUrl, 2_000_000, 4_000).then((img) => (img ? `data:${img.type};base64,${Buffer.from(img.bytes).toString("base64")}` : null))
    : null;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#07080b", color: "#f4f4f5", position: "relative", fontFamily: "Geist" }}>
        {/* the light through the open head, faint behind the coin (the renderer has no CSS masks: gradients sit on top) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${SITE_URL}/art/og-beam.jpg`}
          alt=""
          width={640}
          height={814}
          style={{ position: "absolute", right: -40, top: -60, width: 640, height: 814, opacity: 0.55 }}
        />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, #07080b 38%, rgba(7,8,11,0.85) 52%, rgba(7,8,11,0.25) 72%, rgba(7,8,11,0.05) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(7,8,11,0.5) 0%, rgba(7,8,11,0) 22%, rgba(7,8,11,0) 62%, rgba(7,8,11,0.92) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 50% at 30% 0%, rgba(255,255,255,0.1), transparent 70%)" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, width: "100%", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`${SITE_URL}/art/wordmark.png`} alt="Notus" width={133} height={24} style={{ width: 133, height: 24 }} />
            <span style={{ fontSize: 22, letterSpacing: 4, color: "#6b7383" }}>ON LITECOIN</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
            {logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" width={168} height={168} style={{ width: 168, height: 168, borderRadius: 32, objectFit: "cover", border: "1px solid rgba(255,255,255,0.2)" }} />
            ) : (
              <div style={{ width: 168, height: 168, borderRadius: 32, border: "1px solid rgba(255,255,255,0.2)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 84, color: "#8b93a3" }}>
                {ticker[0]}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 76, lineHeight: 1, letterSpacing: -2, fontWeight: 700 }}>{coin?.name ?? `$${ticker}`}</div>
              <div style={{ display: "flex", gap: 18, fontSize: 34, color: "#8b93a3", letterSpacing: 2 }}>
                <span>${ticker}</span>
                {coin?.graduated && <span>· graduated</span>}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 56 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>MARKET CAP</span>
              <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>{coin ? `${cap} LTC` : "—"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>{coin?.graduated ? "IN THE POOL" : "IN THE CURVE"}</span>
              <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>{coin ? `${(Number(coin.graduated ? coin.poolLit : coin.realLit) / 1e8).toFixed(3)} LTC` : "—"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>HOLDERS</span>
              <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>{coin ? coin.holders : "—"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>{coin?.graduated ? "HELD" : "SOLD"}</span>
              <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1 }}>{coin ? fmtM(coin.graduated ? String(1_000_000_000n * 100_000_000n - BigInt(coin.poolToken)) : coin.sold) : "—"}</span>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      headers: CACHE,
      fonts: [
        { name: "Geist", data: regular, style: "normal", weight: 400 },
        { name: "Geist", data: bold, style: "normal", weight: 700 },
      ],
    }
  );
}
