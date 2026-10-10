import { ImageResponse } from "next/og";
import { SITE_URL } from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "Notus — launch your coin in cbLTC";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const regular = await fetch(`${SITE_URL}/fonts/Geist-Regular.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer());
  const bold = await fetch(`${SITE_URL}/fonts/Geist-Bold.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer());
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#07080b", color: "#f4f4f5", position: "relative", fontFamily: "Geist" }}>
        {/* the profile under its crown, looking at the words (the renderer has no CSS masks: gradients sit on top) */}
        <img
          src={`${SITE_URL}/art/og-profile.jpg`}
          alt=""
          width={600}
          height={763}
          style={{ position: "absolute", right: 0, top: -30, width: 600, height: 763 }}
        />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(90deg, #07080b 40%, rgba(7,8,11,0.8) 52%, rgba(7,8,11,0.15) 68%, rgba(7,8,11,0) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(7,8,11,0.35) 0%, rgba(7,8,11,0) 22%, rgba(7,8,11,0) 68%, rgba(7,8,11,0.92) 100%)" }} />
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 50% at 30% 0%, rgba(255,255,255,0.1), transparent 70%)" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, width: "100%", height: "100%" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <img src={`${SITE_URL}/art/wordmark.png`} alt="Notus" width={155} height={28} style={{ width: 155, height: 28 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", flexDirection: "column", fontSize: 84, lineHeight: 1, letterSpacing: -3, fontWeight: 700 }}>
              <span>Launch your coin</span>
              <div style={{ display: "flex" }}>
                <span style={{ whiteSpace: "pre" }}>{"in "}</span>
                <span style={{ fontWeight: 400, color: "#b3b9c6" }}>cbLTC</span>
                <span>.</span>
              </div>
            </div>
            <div style={{ fontSize: 28, color: "#8b93a3", maxWidth: 600, lineHeight: 1.3 }}>
              Litecoin wrapped by Coinbase, a bonding curve, a locked pool. Every coin moves to LitVM mainnet the day it goes live: same holders, same price.
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, fontSize: 22, color: "#6b7383", letterSpacing: 4 }}>
            <span>CBLTC</span>
            <span>·</span>
            <span>LITVM</span>
            <span>·</span>
            <span>{new URL(SITE_URL).host.toUpperCase()}</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      headers: { "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400" },
      fonts: [
        { name: "Geist", data: regular, style: "normal", weight: 400 },
        { name: "Geist", data: bold, style: "normal", weight: 700 },
      ],
    }
  );
}
