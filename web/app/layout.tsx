import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import "./globals.css";
import { config } from "@/lib/config";
import { Providers } from "./providers";
import { HeaderWallet } from "@/components/HeaderWallet";
import { SOURCE_URL } from "@/lib/site";
import { ChainSwitcher } from "@/components/ChainSwitcher";
import { Nav } from "@/components/Nav";
import { LogoVideo } from "@/components/LogoVideo";
import { BottomNav } from "@/components/BottomNav";
import Link from "next/link";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://notuspad.com";
const DESCRIPTION =
  "Launch and trade coins on Litecoin itself — an OP_RETURN ledger, no smart contracts — and on LitVM, Litecoin's EVM layer. Every coin on Litecoin migrates to LitVM automatically at mainnet: same holders, same price.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Notus — launch your coin on Litecoin", template: "%s · Notus" },
  description: DESCRIPTION,
  applicationName: "Notus",
  openGraph: {
    type: "website",
    siteName: "Notus",
    title: "Notus — launch your coin on Litecoin",
    description: DESCRIPTION,
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image", title: "Notus — launch your coin on Litecoin", description: DESCRIPTION },
};

export const viewport: Viewport = { themeColor: "#07080b", colorScheme: "dark" };

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const initialState = cookieToInitialState(config, headers().get("cookie"));
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased bg-ink text-marble min-h-screen`}
      >
        <Providers initialState={initialState}>
          <header className="sticky top-0 z-30 glass border-x-0 border-t-0">
            <div className="mx-auto max-w-6xl px-3 sm:px-5 py-3 flex items-center justify-between gap-2 sm:gap-4">
              <Link href="/" className="group flex items-center gap-3 shrink-0">
                <span className="relative">
                  <LogoVideo className="h-9 w-9 rounded-full object-cover pointer-events-none select-none ring-1 ring-white/20 group-hover:ring-white/50 transition" />
                  <span className="absolute -inset-1 -z-10 rounded-full bg-white/10 blur-md opacity-0 group-hover:opacity-100 transition" />
                </span>
                <span className="font-mono text-lg font-bold leading-none tracking-[0.28em] text-white">NOTUS</span>
              </Link>
              <Nav />
              <div className="flex items-center gap-2 shrink-0">
                <ChainSwitcher />
                <HeaderWallet />
              </div>
            </div>
            <div className="divider" />
          </header>
          <main className="mx-auto max-w-6xl px-4 sm:px-5 py-8 md:py-12 pb-28 md:pb-14">{children}</main>
          <footer className="mt-10 border-t border-white/[0.06]">
            <div className="mx-auto max-w-6xl px-4 sm:px-5 py-10 mb-16 md:mb-0 grid gap-6 md:grid-cols-[1fr_2fr]">
              <div className="space-y-2">
                <div className="font-mono text-xl font-bold tracking-[0.28em] text-white">NOTUS</div>
                <div className="label">Litecoin · LitVM</div>
                <div className="font-mono text-xs text-zinc-500">
                  {SOURCE_URL ? (
                    <a className="underline hover:text-zinc-200" href={SOURCE_URL} target="_blank">
                      Source
                    </a>
                  ) : (
                    <span title="The code is published at launch">Source published at launch</span>
                  )}
                </div>
              </div>
              <p className="text-xs leading-relaxed text-zinc-500">
                Notus is an independent token launchpad{SOURCE_URL ? ", open source" : "; its code is published at launch"}. It is not
                affiliated with, endorsed by, or operated by Litecoin, the Litecoin Foundation, LitVM or Lester Labs — their names identify the
                public blockchain networks and protocols this app connects to. Cryptoassets are highly volatile; nothing here is financial
                advice.
              </p>
            </div>
          </footer>
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
