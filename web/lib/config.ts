import { defineChain } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { cookieStorage, createConfig, createStorage, http, injected } from "wagmi";

export const giwaSepolia = defineChain({
  id: 91342,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://sepolia-rpc.giwa.io"] },
  },
  blockExplorers: {
    default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Robinhood Explorer",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export { sepolia, mainnet };

// Chains the app runs on (shown in the chain switcher).
export const APP_CHAINS = [giwaSepolia, robinhood] as const;

// One address per chain: add future deployments here (multichain).
export const LAUNCHPAD_ADDRESS: Record<number, `0x${string}` | undefined> = {
  [giwaSepolia.id]: "0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD",
  [robinhood.id]: "0xDE295591af5A8c950fB5Edf564B82a4b0A5f2B04",
};

// Launchpad deployment blocks: where on-chain event scans start.
export const LAUNCHPAD_DEPLOY_BLOCK: Record<number, bigint> = {
  [giwaSepolia.id]: 31_997_798n, // v7.1
  [robinhood.id]: 22_624_070n, // v7.1
};

// Quote assets offered at launch per chain. address null = native ETH.
// To add one (e.g. a tokenized stock): owner must also enable it on-chain
// with setQuoteAsset(asset, virtualReserve).
export type QuoteAssetInfo = {
  address: `0x${string}` | null;
  symbol: string;
  decimals: number;
  /** Uniswap v3 fee hops from WETH for ETH zap buys:
   *  [f1] = WETH -f1-> asset · [f1, f2] = WETH -f1-> USDG -f2-> asset.
   *  Omitted = no ETH route (direct asset buys only). */
  zapFees?: number[];
  /** Synthetic Notus pre-market (pre-IPO company with no open market).
   *  These are graduated Notus launch tokens whitelisted as quote assets:
   *  community price discovery only — no equity, no backing, no affiliation.
   *  Whitelist AFTER graduation only (pre-graduation transfers would block
   *  the paired token's own migration). Their WETH pool from graduation is
   *  the 1% tier, so zapFees: [10000] gives one-transaction ETH buys. */
  preIpo?: boolean;
};

export const PRE_IPO_DISCLAIMER =
  "Synthetic community pre-market: price discovery only. No equity, no backing, no affiliation with the company.";
export const QUOTE_ASSETS: Record<number, QuoteAssetInfo[]> = {
  [giwaSepolia.id]: [{ address: null, symbol: "ETH", decimals: 18 }],
  [robinhood.id]: [
    { address: null, symbol: "ETH", decimals: 18 },
    { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", decimals: 18, zapFees: [500, 500] },
    { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", decimals: 18, zapFees: [500, 3000] },
    { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", symbol: "TSLA", decimals: 18, zapFees: [500, 3000] },
    { address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", symbol: "GME", decimals: 18, zapFees: [500, 500] },
    { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", symbol: "MSFT", decimals: 18, zapFees: [500, 3000] },
    { address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", symbol: "AMZN", decimals: 18, zapFees: [500, 3000] },
    { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", symbol: "META", decimals: 18 },
    { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", symbol: "GOOGL", decimals: 18, zapFees: [500, 3000] },
    { address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", symbol: "COIN", decimals: 18 },
    { address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", symbol: "PLTR", decimals: 18 },
    { address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", symbol: "AMD", decimals: 18 },
    // Notus Pre-Markets go here once graduated + whitelisted on-chain
    // (script/enable-pre-markets.sh): { address, symbol, decimals: 18, preIpo: true, zapFees: [10000] }
  ],
};

// ETH-zap infrastructure on Robinhood Chain (router deployed per launchpad).
export const ZAP_ROUTER: Record<number, `0x${string}` | undefined> = {
  [robinhood.id]: "0x24D96Ec9162264F3E42edE7169dc8967d71E1cfb",
};
export const UNISWAP_QUOTER: Record<number, `0x${string}` | undefined> = {
  [robinhood.id]: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
};
export const WETH9: Record<number, `0x${string}` | undefined> = {
  [robinhood.id]: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
};
export const USDG: Record<number, `0x${string}` | undefined> = {
  [robinhood.id]: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
};

// OP Stack standard bridge for GIWA Sepolia (on Ethereum Sepolia, L1).
// Sending plain ETH to it bridges to the same address on GIWA L2.
export const L1_STANDARD_BRIDGE: `0x${string}` =
  "0x77b2ffc0F57598cAe1DB76cb398059cF5d10A7E7";

// batch coalesces JSON-RPC requests fired in the same tick into a single
// HTTP call — with multicall batching below it cuts RPC round trips
// dramatically. batchSize is capped: public RPCs take seconds to answer a
// single mega-batch (e.g. 300 getBlock calls), while a few mid-size
// parallel requests come back in a fraction of the time.
const transport = () => http(undefined, { batch: { batchSize: 30, wait: 16 } });

export const config = createConfig({
  // Cookie-backed state + ssr: the server renders with the persisted chain,
  // so selection survives reloads without hydration mismatches.
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
  chains: [giwaSepolia, robinhood, sepolia, mainnet],
  connectors: [injected()],
  batch: { multicall: { wait: 16 } },
  transports: {
    [giwaSepolia.id]: transport(),
    [robinhood.id]: transport(),
    [sepolia.id]: transport(),
    [mainnet.id]: transport(),
  },
});
