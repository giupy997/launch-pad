import type { Metadata } from "next";
import localFont from "next/font/local";
import { headers } from "next/headers";
import { cookieToInitialState } from "wagmi";
import "./globals.css";
import { config } from "@/lib/config";
import { Providers } from "./providers";
import { HeaderWallet } from "@/components/HeaderWallet";
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

export const metadata: Metadata = {
  title: "Notus — multichain token launchpad",
  description: "Launch your token on the bonding curve. GIWA Sepolia testnet.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const initialState = cookieToInitialState(config, headers().get("cookie"));
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased bg-black text-white min-h-screen`}
      >
        <Providers initialState={initialState}>
          <header className="border-b border-zinc-800 sticky top-0 bg-black/90 backdrop-blur z-10">
            <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 sm:py-4 flex items-center justify-between gap-2 sm:gap-4">
              <Link
                href="/"
                className="flex items-center gap-2.5 font-mono text-lg font-bold tracking-[0.25em] uppercase shrink-0"
              >
                <LogoVideo className="h-9 w-9 rounded-lg object-cover pointer-events-none select-none" />
                NOTUS
              </Link>
              <Nav />
              <div className="flex items-center gap-2 shrink-0">
                <ChainSwitcher />
                <HeaderWallet />
              </div>
            </div>
          </header>
          <main className="mx-auto max-w-5xl px-4 py-8 md:py-10 pb-24 md:pb-10">{children}</main>
          <footer className="border-t border-zinc-900">
            <div className="mx-auto max-w-5xl px-4 py-8 mb-14 md:mb-0 text-xs text-zinc-600 font-mono tracking-wide">
              NOTUS · MULTICHAIN ·{" "}
              <a
                className="underline hover:text-zinc-300"
                href="https://github.com/giupy997/launchpadgiwa"
                target="_blank"
              >
                SOURCE
              </a>
              <p className="mt-2 normal-case tracking-normal font-sans text-zinc-700">
                Notus is an independent, open-source token launchpad. It is not
                affiliated with, endorsed by, or operated by Robinhood Markets,
                GIWA, Dunamu, Uniswap, Zcash or the Electric Coin Company — their names identify the public
                blockchain networks and protocols this app connects to.
                Cryptoassets are highly volatile; nothing here is financial advice.
              </p>
            </div>
          </footer>
          <BottomNav />
        </Providers>
      </body>
    </html>
  );
}
