"use client";

// A preview of the explore layout and the coin header with made-up coins, to
// look at before the real pages change. Not linked from anywhere; removed
// once the layout is approved.
import { ExploreView } from "@/components/explore/ExploreView";
import type { Coin } from "@/components/explore/types";
import { TokenHeader } from "@/components/TokenHeader";
import { curveProgress, marketCapOf, priceOf, type TokenInfo } from "@/lib/hooks";
import { fmtNum, fmtTokens, fmtUnits } from "@/lib/format";
import { fmtQuoteMoney } from "@/lib/price";

const CBLTC = "0xcb17C9Db87B595717C857a08468793f5bAb6445F" as `0x${string}`;
const V_ETH = 60n * 10n ** 8n; // 60 cbLTC of virtual reserve
const V_TOKEN = 1_073_000_000n * 10n ** 18n;
const NOW = 1_759_800_000; // a fixed clock, so the server and the browser render the same
const USD = 67; // the LTC price

function coin(
  i: number,
  name: string,
  symbol: string,
  progressPct: number,
  graduated: boolean,
  o: Partial<{ change: number | null; volume: number; lastMin: number | null; rewards: boolean; live: boolean; desc: string }> = {}
): Coin {
  const sold = graduated ? 800_000_000n * 10n ** 18n : BigInt(Math.round((800_000_000 * progressPct) / 100)) * 10n ** 18n;
  // x·y = k along the curve: the live virtual reserves, as the contract keeps them
  const vToken = V_TOKEN - sold;
  const vEth = (V_ETH * V_TOKEN) / vToken;
  const realEth = vEth - V_ETH;
  const address = `0x${(i + 1).toString(16).padStart(2, "0")}${"ab".repeat(19)}` as `0x${string}`;
  const token: TokenInfo = {
    address,
    name,
    symbol,
    curve: { vEth, vToken, realEth, sold, graduated, creator: `0x7a30${"5c".repeat(16)}753C` as `0x${string}`, quoteAsset: CBLTC },
    meta: { logoURI: "", website: "", twitter: "", telegram: "", livestream: o.live ? "https://x.com" : "", description: o.desc ?? "" },
    feesToHolders: !!o.rewards,
    isPreMarket: false,
  };
  return {
    token,
    stats: {
      mcap: marketCapOf(token.curve, 8),
      price: priceOf(token.curve, 8),
      volume24h: BigInt(Math.round((o.volume ?? 0) * 1e8)),
      change24h: o.change === undefined ? null : o.change,
      lastTrade: o.lastMin == null ? null : NOW - o.lastMin * 60,
      progress: graduated ? 100 : curveProgress(token.curve),
    },
  };
}

const COINS: Coin[] = [
  coin(6, "Test", "TEST", 100, true, { change: 2.6, volume: 22.4, lastMin: 12 }),
  coin(0, "Orbit", "ORBIT", 83.2, false, { change: 6.9, volume: 12.4, lastMin: 3, rewards: true, live: true }),
  coin(1, "Notus", "NOTUS", 57.4, false, { change: -2.1, volume: 4.8, lastMin: 41 }),
  coin(3, "Astra", "ASTRA", 44.5, false, { change: -0.2, volume: 0.7, lastMin: 360 }),
  coin(7, "Sage", "SAGE", 100, true, { change: -20, volume: 3.1, lastMin: 65 }),
  coin(2, "Lester", "LESTER", 21.0, false, { change: 11, volume: 1.9, lastMin: 130 }),
  coin(4, "Momus", "MOMUS", 12.3, false, { change: 0, volume: 0, lastMin: null }),
  coin(5, "Zephyr", "ZEPH", 5.1, false, { change: null, volume: 0, lastMin: null }),
];

// the king's day: a line that climbs with some noise, the same on every render
const POINTS = Array.from({ length: 48 }, (_, i) => 1 + i * 0.012 + Math.sin(i * 1.7) * 0.025 + Math.cos(i * 0.4) * 0.03);

const notus = COINS[2];
const test = COINS[0];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">{label}</div>
      <div className="mt-1 font-semibold text-sm">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[10px] text-zinc-500 truncate">{sub}</div>}
    </div>
  );
}

export default function PreviewPage() {
  return (
    <div className="space-y-20">
      <div id="explore" className="space-y-4">
        <div className="label">Preview · Explore, below the hero</div>
        <ExploreView
          coins={COINS}
          quote={{ symbol: "cbLTC", decimals: 8 }}
          usd={USD}
          loading={false}
          error={false}
          king={{ coin: COINS[1], holders: 1_012, points: POINTS }}
        />
      </div>

      <div id="token" className="space-y-6">
        <div className="label">Preview · Coin page, the top (on its curve)</div>
        <TokenHeader
          token="0xc0DCC62B190ea0C9Ad6b115c5C9D36177256BeB6"
          name={notus.token.name}
          symbol={notus.token.symbol}
          logoURI=""
          description="Launch your coin in Litecoin. Bonding curves on Base quoted in cbLTC, fees set by the creator, liquidity locked. Moving to LitVM mainnet at launch."
          badges={{ graduated: false, preMarket: false, rewards: false, live: false, preIpoQuote: false }}
          creator={notus.token.curve.creator}
          launched={NOW - 3 * 86_400}
          quote={{ symbol: "cbLTC", decimals: 8, logo: "/chains/litecoin.svg" }}
          usd={USD}
          mcap={notus.stats.mcap}
          price={notus.stats.price}
          change24h={notus.stats.change24h}
          volume24h={notus.stats.volume24h}
          buyTaxBps={100}
          sellTaxBps={100}
          poolFeeBps={null}
          explorer="https://base.blockscout.com"
          links={[
            { label: "Website", href: "https://notus-pad.fun" },
            { label: "X", href: "https://x.com/Notuspad" },
          ]}
        />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="Price" value={`${fmtNum(notus.stats.price)} cbLTC`} sub="<$0.01 per coin · on the curve" />
          <Stat label="Raised" value={fmtQuoteMoney(notus.token.curve.realEth, 8, "cbLTC", USD)} sub={`${fmtUnits(notus.token.curve.realEth, 8)} cbLTC`} />
          <Stat label="Sold" value={fmtTokens(notus.token.curve.sold)} />
          <Stat label="Holders" value="37" sub="wallets with a balance" />
          <Stat label="Curve" value={`${notus.stats.progress.toFixed(1)}%`} sub="of 800M sold" />
        </div>
      </div>

      <div id="token-graduated" className="space-y-6">
        <div className="label">Preview · Coin page, the top (graduated)</div>
        <TokenHeader
          token={test.token.address}
          name="Test"
          symbol="TEST"
          logoURI=""
          badges={{ graduated: true, preMarket: false, rewards: true, live: false, preIpoQuote: false }}
          creator={test.token.curve.creator}
          launched={NOW - 40 * 86_400}
          quote={{ symbol: "cbLTC", decimals: 8, logo: "/chains/litecoin.svg" }}
          usd={USD}
          mcap={test.stats.mcap}
          price={test.stats.price}
          change24h={test.stats.change24h}
          volume24h={test.stats.volume24h}
          buyTaxBps={0}
          sellTaxBps={0}
          poolFeeBps={30}
          explorer="https://base.blockscout.com"
          links={[]}
        />
      </div>
    </div>
  );
}
