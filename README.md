# Notus

**https://notus-pad.fun** — a token launchpad on Litecoin and on LitVM,
Litecoin's EVM layer. What it is, how keys are handled and how to reach us:
[notus-pad.fun/about](https://notus-pad.fun/about).

On Litecoin there are no smart contracts, so Notus runs as an OP_RETURN
ledger: one desk address, instructions in the memos of ordinary Litecoin
transactions signed by the user, balances anyone can recompute from the chain
(live on Litecoin mainnet). On LitVM the same launchpad runs as Solidity
contracts (Liteforge testnet today); when LitVM mainnet goes live, every coin
on the Litecoin ledger migrates there automatically, same holders, same price.
The contracts are chain-agnostic and have run on other EVM chains (GIWA
Sepolia, Robinhood Chain); those integrations stay in the repository.

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
  - `src/NotusV4Hook.sol` — graduation adapter and Uniswap v4 hook in one
    contract (Robinhood Chain): seeds a full-range v4 pool in native ETH (or
    the quote asset) with the DEX reserve, locks the position forever, and
    charges the launchpad's 1% fee on every swap in the pool — in the quote
    asset, for exact-input and exact-output trades alike — depositing it with
    the launchpad, which splits it exactly like a curve fee. Tokens launched
    in holders mode keep paying their holders after graduation, for as long
    as the pool trades. The pool itself charges 0%; only this contract can
    create pools bound to the hook. Fork-tested against the live PoolManager,
    V4Quoter and Universal Router, including a real Robinhood NVDA pair.
  - `src/UniV3Migrator.sol` — legacy v3 graduation adapter (v7.3 and earlier)
  - `src/UniV2Migrator.sol` — graduation adapter for chains whose DEX is
    Uniswap v2 (LitVM): seeds the pool at the curve's final price and keeps
    the LP tokens forever
  - `Launchpad.migrateToken` / `migrateBalances` — owner-only, once per coin:
    re-creates a coin from a frozen contract-less ledger (Notus on Litecoin)
    with its curve state and holder balances, so trading continues at the
    same price; `script/MigrateFromLedger.s.sol` drives it from the file
    `litecoin/migration-snapshot.ts` writes
- `zcash/` — **Notus on Zcash** (testnet): a launchpad with no contracts — one
  shielded address, a published viewing key and a bonding-curve ledger
  replayed from encrypted memos. See [zcash/README.md](zcash/README.md)
- `litecoin/` — **Notus on Litecoin** (mainnet, live at
  [notus-pad.fun/litecoin](https://notus-pad.fun/litecoin)): the same idea on a
  transparent chain — one desk address, instructions in OP_RETURN, balances
  owned by the paying address, every transaction signed by an in-browser
  Litecoin wallet or by a Litecoin browser extension (Litescribe, Enkrypt).
  See [litecoin/README.md](litecoin/README.md)
- `web/` — Next.js 16 + React 19 + wagmi v2 + viem frontend
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
- Graduation: once the 800M are sold out → curve trading closes and the
  200M reserve + raised quote move automatically into a locked Uniswap v4
  pool, where the same 1% fee keeps being charged and split
- Holder cashback is spread over the eligible supply (every wallet, not the
  launchpad or the v4 PoolManager), with debts rounded up so the sum of all
  claims can never exceed what the contract holds

## Deployments

| Chain | Contract | Address |
|---|---|---|
| GIWA Sepolia (91342) | Launchpad | [`0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD`](https://sepolia-explorer.giwa.io/address/0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD) — v7.1 (v7.4 redeploy pending) |
| Robinhood Chain (4663) | Launchpad | [`0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c`](https://robinhoodchain.blockscout.com/address/0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c) — v7.4, 64 quote assets |
| Robinhood Chain (4663) | NotusV4Hook | [`0x11E98A9d691B8730990d9bE1da9CD012f4e320cC`](https://robinhoodchain.blockscout.com/address/0x11E98A9d691B8730990d9bE1da9CD012f4e320cC) — v4 graduation + pool fees |
| Robinhood Chain (4663) | ZapRouter | [`0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5`](https://robinhoodchain.blockscout.com/address/0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5) — ETH zap buys |
| LitVM Liteforge (4441) | Launchpad | [`0x4D3C63F873bc2aC79E529C8003321d60643a4025`](https://liteforge.explorer.caldera.xyz/address/0x4D3C63F873bc2aC79E529C8003321d60643a4025) — v7.7, quoted in zkLTC; `migrateToken` for the Litecoin ledger is bound to its snapshot (`setMigrationRoot` once, `closeMigration` for good, one token per ticker, every holder delivered once, a curve coin funded exactly as its state implies); graduation seeds a locked pool on Lester Labs' Uniswap v2 through `UniV2Migrator` [`0xE34b882BD48D3b13A92C5A7C99469485d1761776`](https://liteforge.explorer.caldera.xyz/address/0xE34b882BD48D3b13A92C5A7C99469485d1761776) (router `0xD56a…FA62`), which absorbs a pre-seeded pair instead of failing on it. The earlier pads `0x2cF3…9580` (v7.5) and `0xcdF1…6725` (v7.6) are retired |
| LitVM Liteforge (4441) | TimelockController | [`0xFaFc00D9f9cD8A82874D05dFd17D6230dB320C87`](https://liteforge.explorer.caldera.xyz/address/0xFaFc00D9f9cD8A82874D05dFd17D6230dB320C87) — owns the Launchpad since block 56,260,690; a 10-minute delay for rehearsals on the testnet (48 hours on mainnet); proposer `0x707f…9A02`, anyone executes what is ready |

### Governance

The Launchpad's owner is meant to be a `TimelockController` (OpenZeppelin),
deployed with `contracts/script/DeployTimelock.s.sol`: every owner call —
fee and its split, treasury, migrator, quote assets, the ledger migration —
is scheduled first and can only run after the delay (48 hours on mainnet),
so any change is visible on chain before it takes effect. The proposer may
schedule and cancel; anyone may execute an operation once it is ready. The
migration script speaks the timelock's language (`MODE=schedule`, then
`MODE=execute`). On Liteforge the timelock above owns the pad; until one is
deployed on a chain, that chain's pad is owned by the deployer key. The
migration of the Litecoin ledger to LitVM mainnet, step by step:
[`litecoin/MIGRATION.md`](litecoin/MIGRATION.md).

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
| OPENAI | [`0x87F5D45737bb5A80Cb6cdcA6732d42c5991156e9`](https://robinhoodchain.blockscout.com/address/0x87F5D45737bb5A80Cb6cdcA6732d42c5991156e9) |
| ANTHRO | [`0xb9DbeEB586e246919f16d322F53b64c60f1d31F3`](https://robinhoodchain.blockscout.com/address/0xb9DbeEB586e246919f16d322F53b64c60f1d31F3) |
| XAI | [`0x771d56D235c0dE30c81503406cDd0f1d409B645c`](https://robinhoodchain.blockscout.com/address/0x771d56D235c0dE30c81503406cDd0f1d409B645c) |
| STRIPE | [`0xa4a6877e02AD9A773DCF58d702B3c773139F788b`](https://robinhoodchain.blockscout.com/address/0xa4a6877e02AD9A773DCF58d702B3c773139F788b) |

(previous GIWA deployments: `0x1f3F...fC73` no creator fees, `0xf71b...9cC1` no metadata)

## Multichain

The app has a chain switcher in the header. It offers **Litecoin** (the
contract-less ledger, its own section of the site at `/litecoin`) and **LitVM
Liteforge**; GIWA Sepolia, Robinhood Chain and Zcash Testnet (`/zcash`) stay
wired — addresses, assets, pages — but out of the menu (`VISIBLE_CHAINS` in
`web/lib/config.ts` lists what the menu shows; LitVM is the default EVM
chain). LitVM (chain 4441, RPC `https://liteforge.rpc.caldera.xyz/infra-partner-http`,
explorer `https://liteforge.explorer.caldera.xyz`, gas in zkLTC) is Litecoin's
EVM layer 2: when LitVM mainnet goes live, the Litecoin ledger's coins migrate
there automatically — same holders, same price, each coin's pool moved to a
DEX — see [litecoin/README.md](litecoin/README.md#the-road-to-litvm).
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
forge test                       # incl. a cashback-solvency fuzz and the ledger-migration suite
# v4 hook against the live Robinhood v4 stack: RUN_FORK=true forge test --match-contract NotusV4Hook
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
