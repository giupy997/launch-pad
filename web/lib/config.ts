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
  [robinhood.id]: "0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c", // v7.4
};

// Launchpad deployment blocks: where on-chain event scans start.
export const LAUNCHPAD_DEPLOY_BLOCK: Record<number, bigint> = {
  [giwaSepolia.id]: 31_997_798n, // v7.1
  [robinhood.id]: 61_447_720n, // v7.4
};

// Quote assets offered at launch per chain. address null = native ETH.
// To add one (e.g. a tokenized stock): owner must also enable it on-chain
// with setQuoteAsset(asset, virtualReserve).
/** native = the chain's gas token · stock/etf = official Robinhood tokenized
 *  RWAs · preipo = official token of a private company (SPCX) · premarket =
 *  Notus synthetic pre-market (createPreMarket): a transferable launch token
 *  on its own ETH curve, whitelisted as a quote asset from day one, pure
 *  community price discovery with no equity or backing. */
export type QuoteAssetKind = "native" | "stable" | "stock" | "etf" | "preipo" | "premarket";

export type QuoteAssetInfo = {
  address: `0x${string}` | null;
  symbol: string;
  /** Full asset name, shown in the pair picker (e.g. "SPDR Gold Shares"). */
  name?: string;
  decimals: number;
  kind: QuoteAssetKind;
  /** Uniswap v3 fee hops from WETH for ETH zap buys (existing RWA pools):
   *  [f1] = WETH -f1-> asset · [f1, f2] = WETH -f1-> USDG -f2-> asset.
   *  Measured from live pool liquidity. Omitted = no ETH pool route; for
   *  premarket assets ETH still zaps through their own curve instead. */
  zapFees?: number[];
};

export const PRE_IPO_DISCLAIMER =
  "Synthetic community pre-market: price discovery only. No equity, no backing, no affiliation with the company.";
export const QUOTE_ASSETS: Record<number, QuoteAssetInfo[]> = {
  [giwaSepolia.id]: [{ address: null, symbol: "ETH", decimals: 18, kind: "native" }],
  [robinhood.id]: [
    { address: null, symbol: "ETH", decimals: 18, kind: "native" },
    { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", name: "Global Dollar", decimals: 6, kind: "stable", zapFees: [500] },
    // Notus synthetic pre-markets (createPreMarket): transferable from day
    // one, rewards fee mode, whitelisted as quote assets on creation. ETH
    // buys route through their own curve (ZapRouter.zapBuyCurve) while it is
    // open; once a pre-market graduates into its Uniswap v4 pool the curve
    // zap stops and paired tokens are bought with the pre-market directly.
    { address: "0xD1f2f5CdC507b76e72B245EC32eDBED68babE50F", symbol: "OPENAI", name: "OpenAI Pre-Market", decimals: 18, kind: "premarket" },
    { address: "0x5e6cbD4535bf47B7ccb1d8A25f9831461a7D5534", symbol: "ANTHRO", name: "Anthropic Pre-Market", decimals: 18, kind: "premarket" },
    { address: "0x5CfbDb207FA7dDBB601A47C6Ff6FBDC77dB72BC8", symbol: "XAI", name: "xAI Pre-Market", decimals: 18, kind: "premarket" },
    { address: "0x0eE6e9647FDD52F13f8a511EbC1CCBd2337A9f2f", symbol: "STRIPE", name: "Stripe Pre-Market", decimals: 18, kind: "premarket" },
    { address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", symbol: "SPCX", name: "SpaceX", decimals: 18, kind: "preipo", zapFees: [500] },
    { address: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", symbol: "GLD", name: "SPDR Gold Shares", decimals: 18, kind: "etf", zapFees: [10000] },
    { address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", symbol: "QQQ", name: "Invesco QQQ", decimals: 18, kind: "etf", zapFees: [3000] },
    { address: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5", symbol: "SGOV", name: "iShares 0-3M Treasury Bond", decimals: 18, kind: "etf", zapFees: [10000] },
    { address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", symbol: "SLV", name: "iShares Silver Trust", decimals: 18, kind: "etf", zapFees: [3000] },
    { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", symbol: "SPY", name: "SPDR S&P 500 ETF", decimals: 18, kind: "etf", zapFees: [500] },
    { address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", symbol: "USO", name: "United States Oil Fund", decimals: 18, kind: "etf", zapFees: [500, 3000] },
    { address: "0x15Cd20759CE7F3285c29A319dE2D1A2e098c6f43", symbol: "XLK", name: "Technology Select Sector SPDR", decimals: 18, kind: "etf" },
    { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", name: "Apple", decimals: 18, kind: "stock", zapFees: [500] },
    { address: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", symbol: "AMC", name: "AMC Entertainment", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", symbol: "AMD", name: "Advanced Micro Devices", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", symbol: "AMZN", name: "Amazon", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA", symbol: "ASML", name: "ASML Holding", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0x4D21483a44Bf67a86b77E3dA301411880797D452", symbol: "BA", name: "Boeing", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4", symbol: "BABA", name: "Alibaba", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x48E39E56aCdbA37b09020C0b734A613C9a2f100A", symbol: "BB", name: "BlackBerry", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0x822CC93fFD030293E9842c30BBD678F530701867", symbol: "BE", name: "Bloom Energy", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x9651342CeA770aE9a2969Ba2A52611523146aef9", symbol: "CCL", name: "Carnival", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", symbol: "COIN", name: "Coinbase", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2", symbol: "COST", name: "Costco", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", symbol: "CRCL", name: "Circle", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3", symbol: "CRWV", name: "CoreWeave", decimals: 18, kind: "stock" },
    { address: "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", symbol: "DELL", name: "Dell", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516", symbol: "DJT", name: "Trump Media", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x25C288E6D899b9BC30160965aD9644c67e73bE0C", symbol: "F", name: "Ford Motor", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x41F4267525a8AFf329540eF24fD83d9044758B33", symbol: "FIG", name: "Figma", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", symbol: "GME", name: "GameStop", decimals: 18, kind: "stock", zapFees: [500] },
    { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", symbol: "GOOGL", name: "Alphabet", decimals: 18, kind: "stock", zapFees: [100] },
    { address: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", symbol: "HIMS", name: "Hims & Hers", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619", symbol: "IBM", name: "IBM", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", symbol: "INTC", name: "Intel", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80", symbol: "JNJ", name: "Johnson & Johnson", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x8005d266423c7ea827372c9c864491e5786600ea", symbol: "LLY", name: "Eli Lilly", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x329fcACEb9AD6F9580DD5F643fed0646900D043c", symbol: "LMT", name: "Lockheed Martin", decimals: 18, kind: "stock" },
    { address: "0x4e62068525Ab11FE768e29dfD00ef909B9803016", symbol: "LULU", name: "Lululemon", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", symbol: "META", name: "Meta", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x43B07D15cE533bEc5476d70C22a78a1B2B662155", symbol: "MRNA", name: "Moderna", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", symbol: "MSFT", name: "Microsoft", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0xec262a75e413fAfD0dF80480274532C79D42da09", symbol: "MSTR", name: "Strategy", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", symbol: "MU", name: "Micron", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0x9D9c6684F596F66a64C030B93A886D51Fd4D7931", symbol: "NBIS", name: "Nebius Group", decimals: 18, kind: "stock" },
    { address: "0x116F00968269B7bfbaD4109cE591d6E74c0601d4", symbol: "NET", name: "Cloudflare", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8", symbol: "NFLX", name: "Netflix", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x408c14038a04f7bD235329E26d2bf569ee20e250", symbol: "NU", name: "Nu Holdings", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", name: "NVIDIA", decimals: 18, kind: "stock", zapFees: [500] },
    { address: "0xb0992820E760d836549ba69BC7598b4af75dEE03", symbol: "ORCL", name: "Oracle", decimals: 18, kind: "stock" },
    { address: "0x7066A64c24e4206CD62E83bf198c1E7EB361F51e", symbol: "PFE", name: "Pfizer", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", symbol: "PLTR", name: "Palantir", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x59818904ab4cE163b3cE4FfB64f2D6Ca02c434B4", symbol: "QUBT", name: "Quantum Computing", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8", symbol: "RBLX", name: "Roblox", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", symbol: "RDDT", name: "Reddit", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B", symbol: "RIVN", name: "Rivian", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0xF53F66751B1Eff985311b693531E3290F600c410", symbol: "SHOP", name: "Shopify", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8", symbol: "SKHY", name: "SK hynix", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0xF6589F11Bc40b669e584073F428B05562F568733", symbol: "SNAP", name: "Snap", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", symbol: "SNDK", name: "SanDisk", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0xBa0CAB75495255d0cB58E22B648bFED4ECD1F47E", symbol: "SNOW", name: "Snowflake", decimals: 18, kind: "stock", zapFees: [500, 3000] },
    { address: "0x98E75885157C80992A8D41b696D8c9C6Fb30A926", symbol: "SOFI", name: "SoFi Technologies", decimals: 18, kind: "stock" },
    { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", symbol: "TSLA", name: "Tesla", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", symbol: "TSM", name: "Taiwan Semiconductor", decimals: 18, kind: "stock", zapFees: [3000] },
    { address: "0x5e81213613b6B86EaB4c6c50d718d34359459786", symbol: "TTWO", name: "Take-Two Interactive", decimals: 18, kind: "stock", zapFees: [10000] },
    { address: "0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2", symbol: "UPS", name: "UPS", decimals: 18, kind: "stock", zapFees: [500, 10000] },
    { address: "0xd917B029C761D264c6A312BBbcDA868658eF86a6", symbol: "USAR", name: "USA Rare Earth", decimals: 18, kind: "stock", zapFees: [500, 3000] },
  ],
};

/** Official Robinhood logo for a tokenized RWA (deterministic CDN path).
 *  Notus pre-markets have no CDN logo and fall back to their on-chain one. */
export function rwaLogo(asset: QuoteAssetInfo): string | undefined {
  if (!asset.address || asset.kind === "premarket" || asset.kind === "native") return undefined;
  if (asset.kind === "stable") return undefined;
  return `https://cdn.robinhood.com/ncw_assets/logos/${asset.address.toLowerCase()}.png`;
}

// ETH-zap infrastructure on Robinhood Chain (router deployed per launchpad).
export const ZAP_ROUTER: Record<number, `0x${string}` | undefined> = {
  [robinhood.id]: "0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5", // v7.4
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
