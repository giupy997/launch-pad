# Notus

Pump.fun-style launchpad for launching tokens on EVM chains. Primary target:
**GIWA** (Upbit/Dunamu's OP Stack L2), with a chain-agnostic architecture for
future multichain deployments (Monad, MegaETH, ...).

## Structure

- `contracts/` — smart contracts (Solidity + Foundry)
  - `src/Launchpad.sol` — factory + bonding curve (constant product with
    virtual reserves), graduation with automatic DEX migration (manual fallback if the DEX leg fails); on-chain token metadata
    (1:1 logo URI, website, X, Telegram, livestream URL) editable by the
    creator; 1% trade fee split 50% creator (pull-based `claimCreatorFees`)
    / 30% holder cashback (pro-rata accumulator, `claimCashback`) / 20%
    treasury, with a per-token creator-settable fee recipient
    (`setFeeRecipient`, pump.fun-style redirect)
  - `src/LaunchToken.sol` — ERC-20 created by the launchpad; transfers locked
    until graduation
  - `src/interfaces/IDexMigrator.sol` — pluggable DEX adapter (one per chain)
  - `script/launch-pre-markets.sh` + `script/enable-pre-markets.sh` — Notus
    Pre-Markets: synthetic pre-IPO tokens (OpenAI, Anthropic, ...) launched as
    regular ETH curves and, once graduated, whitelisted as quote assets so new
    tokens can pair with them (stonkfun-style; clearly disclaimed as
    price-discovery only — no equity, no backing, no affiliation)
  - `src/UniV3Migrator.sol` — graduation adapter for Robinhood Chain: seeds a
    full-range Uniswap v3 pool (1% tier), locks the LP NFT forever and splits
    the perpetual LP fees 50/50 creator/treasury (fork-tested against the
    live Uniswap deployment)
- `web/` — Next.js 14 + wagmi v2 + viem frontend
  - `/` Explore: on-chain token list (multicall, 5s refresh) with search
    and sorting
  - `/create`: token creation with logo (1:1) and social links
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
- Fee: 1% on buys and sells (max 5%, owner-configurable)
- Graduation: once the 800M are sold out → curve trading closes,
  `migrate()` moves 200M tokens + raised ETH to the DEX adapter

## Deployments

| Chain | Contract | Address |
|---|---|---|
| GIWA Sepolia (91342) | Launchpad | [`0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD`](https://sepolia-explorer.giwa.io/address/0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD) — v7.1 |
| Robinhood Chain (4663) | Launchpad | [`0xDE295591af5A8c950fB5Edf564B82a4b0A5f2B04`](https://robinhoodchain.blockscout.com/address/0xDE295591af5A8c950fB5Edf564B82a4b0A5f2B04) — v7.1, 11 stocks whitelisted |
| Robinhood Chain (4663) | UniV3Migrator | [`0x3FEAe4c7D5216EbB9Cf3135A645ceb36AfEf57eE`](https://robinhoodchain.blockscout.com/address/0x3FEAe4c7D5216EbB9Cf3135A645ceb36AfEf57eE) — wired |
| Robinhood Chain (4663) | ZapRouter | [`0x24D96Ec9162264F3E42edE7169dc8967d71E1cfb`](https://robinhoodchain.blockscout.com/address/0x24d96ec9162264f3e42ede7169dc8967d71e1cfb) — ETH zap buys |

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
forge test                       # 33 tests incl. fuzz; fork test: RUN_FORK=true forge test --match-contract Fork
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
