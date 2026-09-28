import { ImageResponse } from "next/og";
import { SITE_URL } from "@/lib/litecoin/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "Notus — launch your coin on Litecoin";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  const serif = await fetch(`${SITE_URL}/fonts/InstrumentSerif-Regular.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer());
  const italic = await fetch(`${SITE_URL}/fonts/InstrumentSerif-Italic.ttf`, { cache: "force-cache" }).then((r) => r.arrayBuffer());
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
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, letterSpacing: 8 }}>NOTUS</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", flexDirection: "column", fontSize: 96, lineHeight: 0.95, letterSpacing: -1 }}>
              <span>Launch your coin</span>
              <div style={{ display: "flex" }}>
                <span style={{ whiteSpace: "pre" }}>{"on "}</span>
                <span style={{ fontFamily: "Instrument Serif Italic", color: "#d6dae2" }}>Litecoin</span>
                <span>.</span>
              </div>
            </div>
            <div style={{ fontSize: 28, color: "#8b93a3", maxWidth: 720, lineHeight: 1.3 }}>
              No smart contracts: an OP_RETURN ledger, a bonding curve, a locked pool. Coins migrate to LitVM automatically at mainnet.
            </div>
          </div>
          <div style={{ display: "flex", gap: 24, fontSize: 22, color: "#6b7383", letterSpacing: 4 }}>
            <span>LITECOIN</span>
            <span>·</span>
            <span>LITVM</span>
            <span>·</span>
            <span>NOTUSPAD.COM</span>
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
