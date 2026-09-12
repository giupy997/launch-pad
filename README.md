# Notus

Pump.fun-style launchpad for launching tokens on EVM chains. Primary target:
**GIWA** (Upbit/Dunamu's OP Stack L2), with a chain-agnostic architecture for
future multichain deployments (Monad, MegaETH, ...).

## Structure

- `contracts/` — smart contracts (Solidity + Foundry)
  - `src/Launchpad.sol` — factory + bonding curve (constant product with
    virtual reserves), graduation with automatic DEX migration (manual
    fallback if the DEX leg fails); on-chain token metadata (1:1 logo URI,
    website, X, Telegram, livestream URL) editable by the creator; curves
    quoted in ETH or in any whitelisted ERC-20 (stocks, ETFs, stablecoin,
    pre-IPO); 1% trade fee, of which 20% is treasury and the other 80% goes
    — by the creator's irrevocable choice at launch (`feesToHolders`) —
    either entirely to the creator (`claimCreatorFees`, redirectable with
    `setFeeRecipient`) or entirely to holders as pro-rata cashback
    (`claimCashback`); `createPreMarket` mints a synthetic pre-IPO pair
    asset, transferable from day one and whitelisted on creation
  - `src/LaunchToken.sol` — ERC-20 created by the launchpad; transfers locked
    until graduation, except for pre-markets, which are transferable from
    day one so they can serve as pair assets right away
  - `src/interfaces/IDexMigrator.sol` — pluggable DEX adapter (one per chain)
  - `src/ZapRouter.sol` — one-transaction ETH buys on asset-quoted curves:
    through Uniswap for RWA pairs, or straight through the pre-market's own
    curve for Notus Pre-Markets (no pool needed)
  - `script/enable-rwa-quotes.sh` — enables the whole RWA catalogue as quote
    assets in one `setQuoteAssets` transaction
  - `script/create-pre-markets.sh` — creates the Notus Pre-Markets and
    whitelists SPCX
  - `src/UniV3Migrator.sol` — graduation adapter for Robinhood Chain: seeds a
    full-range Uniswap v3 pool (1% tier), locks the LP NFT forever and splits
    the perpetual LP fees 50/50 creator/treasury (fork-tested against the
    live Uniswap deployment)
- `web/` — Next.js 14 + wagmi v2 + viem frontend
  - `/` Explore: on-chain token list (multicall, 5s refresh) with search
    and sorting
  - `/create`: token creation with logo (1:1) and social links, a searchable
    pair picker over all 64 quote assets (grouped Pre-IPO / ETFs & commodities
    / Stocks, with official logos) and the irrevocable fee-destination choice
  - `/token/[address]`: curve stats, progress bar, buy/sell box with
    on-chain quotes, automatic approve and 1% slippage guard; price chart
    and trade feed built client-side from on-chain events (no indexer:
    one full-range `eth_getLogs` where the RPC allows it, chunked otherwise,
    with an incremental localStorage cache so revisits only scan new
    blocks); embedded livestream
    player (YouTube/Twitch allowlist) with LIVE badges in Explore; creator
    panel to go live and redirect fees
  - `/swap`: ETH ↔ token swaps on the curve; token → token routed
    through ETH in two transactions
  - `/bridge`: chain-aware — on GIWA, in-app ETH deposits Ethereum
    Sepolia → GIWA via the OP Stack Standard Bridge (L1StandardBridge
    `0x77b2ffc0F57598cAe1DB76cb398059cF5d10A7E7`); on Robinhood Chain,
    live Ethereum/Robinhood balances and a link to the Arbitrum
    canonical bridge (the official route per Robinhood docs)
  - `/profile`: connected wallet holdings and created tokens

## Curve parameters

- Total supply: 1B per token; 800M sold on the curve, 200M reserved for DEX
- Virtual reserves: 1.25 ETH / 1.05B tokens → the curve raises ~4 ETH
- Fee: 1% on buys and sells (max 5%, owner-configurable), split 20%
  treasury / 80% to the creator or to holders per the launch-time choice
- Graduation: once the 800M are sold out → curve trading closes,
  `migrate()` moves 200M tokens + raised ETH to the DEX adapter

## Deployments

| Chain | Contract | Address |
|---|---|---|
| GIWA Sepolia (91342) | Launchpad | [`0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD`](https://sepolia-explorer.giwa.io/address/0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD) — v7.1 (v7.3 redeploy pending) |
| Robinhood Chain (4663) | Launchpad | [`0x39fE527714571FE9EA35c4e19C5Bc66503f6F777`](https://robinhoodchain.blockscout.com/address/0x39fE527714571FE9EA35c4e19C5Bc66503f6F777) — v7.3, 64 quote assets |
| Robinhood Chain (4663) | UniV3Migrator | [`0xa48432984D508A686A7ab86BFe2359f980e53dC3`](https://robinhoodchain.blockscout.com/address/0xa48432984D508A686A7ab86BFe2359f980e53dC3) — wired |
| Robinhood Chain (4663) | ZapRouter | [`0x6b52d9C2631f216fe3076149C0A8cb36864a9D81`](https://robinhoodchain.blockscout.com/address/0x6b52d9C2631f216fe3076149C0A8cb36864a9D81) — ETH zap buys |

### Pair assets (Robinhood Chain)

64 quote assets: 55 tokenized stocks, 7 ETFs and commodities (SPY, QQQ,
XLK, GLD gold, SLV silver, USO oil, SGOV treasuries), USDG, SPCX
(SpaceX, pre-IPO) and the four Notus Pre-Markets below. Every RWA
address is verified on-chain (symbol, 18 decimals, official
`... - Robinhood Token` name); virtual reserves are sized from live
prices for a ~$14k raise, and 57 of them have a measured Uniswap route
for one-transaction ETH buys.

Notus Pre-Markets — synthetic pre-IPO markets created with
`createPreMarket`: transferable from day one, holder-rewards fee mode,
whitelisted as quote assets on creation. Price discovery only: no
equity, no backing, no affiliation with the companies.

| Pre-market | Address |
|---|---|
| OPENAI | [`0xD1f2f5CdC507b76e72B245EC32eDBED68babE50F`](https://robinhoodchain.blockscout.com/address/0xD1f2f5CdC507b76e72B245EC32eDBED68babE50F) |
| ANTHRO | [`0x5e6cbD4535bf47B7ccb1d8A25f9831461a7D5534`](https://robinhoodchain.blockscout.com/address/0x5e6cbD4535bf47B7ccb1d8A25f9831461a7D5534) |
| XAI | [`0x5CfbDb207FA7dDBB601A47C6Ff6FBDC77dB72BC8`](https://robinhoodchain.blockscout.com/address/0x5CfbDb207FA7dDBB601A47C6Ff6FBDC77dB72BC8) |
| STRIPE | [`0x0eE6e9647FDD52F13f8a511EbC1CCBd2337A9f2f`](https://robinhoodchain.blockscout.com/address/0x0eE6e9647FDD52F13f8a511EbC1CCBd2337A9f2f) |

(previous GIWA deployments: `0x1f3F...fC73` no creator fees, `0xf71b...9cC1` no metadata)

## Multichain

The app has a chain switcher in the header (GIWA Sepolia · Robinhood Chain).
Per-chain launchpad addresses live in `web/lib/config.ts` (`LAUNCHPAD_ADDRESS`);
chains without a deployment show a notice and disable trading. Robinhood
Chain (Arbitrum Orbit, chain ID 4663, RPC `https://rpc.mainnet.chain.robinhood.com`,
explorer `https://robinhoodchain.blockscout.com`) is a mainnet: using it
costs real ETH, and the contracts are unaudited — trade accordingly.

## Network: GIWA Sepolia (testnet)

| Parameter | Value |
|---|---|
| Chain ID | 91342 |
| RPC | https://sepolia-rpc.giwa.io/ |
| Explorer | https://sepolia-explorer.giwa.io |
| Gas token | ETH (test) |
| Faucet | see https://docs.giwa.io/get-started/faucets |

## Commands

```bash
cd contracts
forge test                       # 55 tests incl. fuzz
# fork tests against live contracts: RUN_FORK_LIVE=true forge test --match-contract Live
```

```bash
cd web && npm install && npm run dev   # frontend at http://localhost:3000
```

Deploy to GIWA Sepolia (requires `.env` with `PRIVATE_KEY`, see `.env.example`):

```bash
cd contracts && source .env && forge script script/Deploy.s.sol --rpc-url giwa_sepolia --private-key "$PRIVATE_KEY" --broadcast
```

## TODO

- [x] Deploy to GIWA Sepolia (Jul 27, 2026) and read-only smoke test
- [x] On-chain smoke test: test token [`TEST` 0x7Fc8...1305](https://sepolia-explorer.giwa.io/address/0x7Fc8d6f3AD8b93F771Cd0Dadd458A495c42F1305) created with initial buy, curve and pricing verified
- [x] Next.js + wagmi frontend (create, list, buy, sell)
- [x] Source verification on Blockscout (Launchpad and TEST token)
- [ ] `IDexMigrator` adapter for a DEX on GIWA (to pick once the mainnet
      ecosystem is live)
- [x] Trade feed + price chart from on-chain events (client-side getLogs)
- [x] Robinhood v5 + UniV3Migrator deployed, verified and wired: graduation
      now auto-migrates to a locked full-range Uniswap v3 pool (1% tier)
- [ ] End-to-end frontend test with a wallet (MetaMask) on GIWA Sepolia
- [ ] Verify permissionless deploy policy on GIWA mainnet
- [ ] Legal review (MiCA) before public launch
