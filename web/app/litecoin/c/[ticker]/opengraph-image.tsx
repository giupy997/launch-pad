import { ImageResponse } from "next/og";
import { readCoin, SITE_URL } from "@/lib/litecoin/server";
import { spotPrice } from "@/lib/litecoin/ledger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "A coin on Notus";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const fmtM = (units: string) => `${(Number(units) / 1e8 / 1e6).toFixed(2)}M`;

export default async function Image({ params }: { params: { ticker: string } }) {
  const ticker = decodeURIComponent(params.ticker).toUpperCase();
  const [found, serif, italic] = await Promise.all([
    readCoin(ticker),
    fetch(`${SITE_URL}/fonts/InstrumentSerif-Regular.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer()),
    fetch(`${SITE_URL}/fonts/InstrumentSerif-Italic.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer()),
  ]);
  const coin = found?.coin;
  const capLtc = coin ? spotPrice(coin) * 1_000_000_000 : 0;
  const cap = capLtc >= 100 ? capLtc.toFixed(0) : capLtc.toFixed(2);
  const logoUrl = coin?.logo && /^https?:\/\//.test(coin.logo) ? coin.logo : coin?.logo?.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${coin.logo.slice(7)}` : null;
  // fetched here, so a logo host that is slow or down costs the letter, not the whole card
  const logo = logoUrl
    ? await fetch(logoUrl, { signal: AbortSignal.timeout(4_000) })
        .then(async (r) => {
          const type = r.headers.get("content-type") ?? "";
          if (!r.ok || !type.startsWith("image/")) return null;
          const buf = Buffer.from(await r.arrayBuffer());
          return buf.length > 0 && buf.length < 2_000_000 ? `data:${type};base64,${buf.toString("base64")}` : null;
        })
        .catch(() => null)
    : null;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#07080b", color: "#f4f4f5", position: "relative", fontFamily: "Instrument Serif" }}>
        {/* the statue, lit from above, fading into the card (the renderer has no CSS masks: a gradient sits on top) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${SITE_URL}/profile-bg.jpg`}
          alt=""
          width={820}
          height={820}
          style={{ position: "absolute", right: -70, top: -90, width: 820, height: 820, objectFit: "cover", opacity: 0.55 }}
        />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, #07080b 42%, rgba(7,8,11,0.85) 56%, rgba(7,8,11,0.2) 80%, rgba(7,8,11,0) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(7,8,11,0.7) 0%, rgba(7,8,11,0) 25%, rgba(7,8,11,0) 75%, rgba(7,8,11,0.8) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 50% at 30% 0%, rgba(255,255,255,0.12), transparent 70%)" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, width: "100%", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 28, letterSpacing: 8, color: "#b3b9c6" }}>
            <span>NOTUS</span>
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
              <div style={{ fontSize: 88, lineHeight: 0.95 }}>{coin?.name ?? `$${ticker}`}</div>
              <div style={{ display: "flex", gap: 18, fontSize: 34, color: "#8b93a3", letterSpacing: 2 }}>
                <span>${ticker}</span>
                {coin?.graduated && <span>· graduated</span>}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 56 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>MARKET CAP</span>
              <span style={{ fontSize: 48 }}>{coin ? `${cap} LTC` : "—"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>{coin?.graduated ? "IN THE POOL" : "IN THE CURVE"}</span>
              <span style={{ fontSize: 48 }}>{coin ? `${(Number(coin.graduated ? coin.poolLit : coin.realLit) / 1e8).toFixed(3)} LTC` : "—"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>HOLDERS</span>
              <span style={{ fontSize: 48 }}>{coin ? coin.holders : "—"}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontSize: 20, letterSpacing: 4, color: "#6b7383" }}>{coin?.graduated ? "HELD" : "SOLD"}</span>
              <span style={{ fontSize: 48 }}>{coin ? fmtM(coin.graduated ? String(1_000_000_000n * 100_000_000n - BigInt(coin.poolToken)) : coin.sold) : "—"}</span>
            </div>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Instrument Serif", data: serif, style: "normal", weight: 400 },
        { name: "Instrument Serif Italic", data: italic, style: "italic", weight: 400 },
      ],
    }
  );
}
