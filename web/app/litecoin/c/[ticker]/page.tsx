import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readCoin } from "@/lib/litecoin/server";
import { spotPrice } from "@/lib/litecoin/ledger";
import { tickerFromParam } from "@/lib/litecoin/client";
import { CoinPage } from "./CoinPage";

type Props = { params: { ticker: string } };

/** Link previews (Telegram, X, Discord) get the coin's name, cap and logo card. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ticker = tickerFromParam(params.ticker);
  if (!ticker) return { title: "Not found" };
  const found = await readCoin(ticker);
  if (!found) {
    return { title: `$${ticker}`, description: "A coin on Notus, the launchpad on Litecoin itself. Coins migrate to LitVM automatically at mainnet." };
  }
  const { coin } = found;
  const capLtc = spotPrice(coin) * 1_000_000_000;
  const cap = capLtc >= 100 ? capLtc.toFixed(0) : capLtc.toFixed(2);
  const description = `${coin.name} on Litecoin — market cap ${cap} LTC · ${coin.holders} holder${coin.holders === 1 ? "" : "s"}${coin.graduated ? " · graduated, locked pool" : ""}. Launched on Notus: buy and sell with LTC; migrates to LitVM automatically at mainnet.`;
  const title = `$${coin.ticker} · ${coin.name}`;
  return {
    title,
    description,
    openGraph: { title: `${title} · Notus`, description, type: "website" },
    twitter: { card: "summary_large_image", title: `${title} · Notus`, description },
  };
}

export default function Page({ params }: Props) {
  if (!tickerFromParam(params.ticker)) notFound();
  return <CoinPage params={params} />;
}
