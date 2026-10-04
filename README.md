# Notus

**https://notus-pad.fun** — a token launchpad on Base, quoted in cbLTC:
Litecoin wrapped by Coinbase, one LTC in custody for every token, with a
public proof of reserves. What it is, how keys are handled and how to reach
us: [notus-pad.fun/about](https://notus-pad.fun/about).

The same Solidity contracts run on LitVM's Liteforge testnet (Litecoin's EVM
layer; its mainnet is expected later in 2026) and have run on GIWA Sepolia and
Robinhood Chain; those integrations stay in the repository. Notus started as
an OP_RETURN ledger on Litecoin itself — one desk address, instructions in the
memos of ordinary transactions, balances anyone recomputes from the chain —
which is winding down: its only buyer was its operator, and a key kept in the
browser plus LTC that has to arrive from another chain proved more than a user
takes on. The ledger, its desk and its migration tooling stay in `litecoin/`
and at `/litecoin`, out of the menu.

## Structure

- `contracts/` — smart contracts (Solidity + Foundry)
  - `src/Launchpad.sol` — factory + bonding curve (constant product with
    virtual reserves), graduation with automatic DEX migration (manual
    fallback if the DEX leg fails); on-chain token metadata (1:1 logo URI,
    website, X, Telegram, livestream URL) editable by the creator; curves
    quoted in ETH or in any whitelisted ERC-20 (stocks, ETFs, stablecoin,
    pre-IPO); a 1% platform fee on every curve trade, 20% of it to the
    treasury, plus the coin's own tax — up to 10% on buys and on sells,
    fixed at launch (`createTokenWithFees`, `FeeConfig`) — and the coin's
    pot (the platform fee's 80% and the whole tax) split as its creator
    fixed it between the creator (`claimCreatorFees`, redirectable with
    `setFeeRecipient`), its holders as pro-rata cashback (`claimCashback`),
    a burn pot that buys the coin back on its curve or its pool and burns it
    (`buybackAndBurn`, anyone may call it) and a liquidity pot that joins
    the pool at graduation; the freeze and `migrateOut` for a move to
    another chain (see `MIGRATION.md`); `createPreMarket` mints a synthetic
    pre-IPO pair asset, transferable from day one and whitelisted on creation
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
    contract, for the v7.4 pad on Robinhood Chain (the current Launchpad no
    longer takes pool fees: its fees end with the curve): seeds a full-range v4 pool in native ETH (or
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
    Uniswap v2 (Base, LitVM): seeds the pool at the curve's final price and
    keeps the LP tokens forever. Nothing of the reserve is ever traded into
    or deposited at a price somebody else set: a pool pre-seeded at another
    price is nudged to ours only when that costs next to nothing, otherwise
    the reserve is parked, still the coin's, for a `seed` once the pool is
    back at our price (the v1 adapter traded the pool back to our price and
    joined it; that is how the Base v9 pools were taken, below)
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
- Platform fee: 1% on buys and sells (max 5%, owner-configurable), 20% of
  it to the treasury; a coin's own tax on top, up to 10% each way, fixed at
  launch; the coin's pot (the platform fee's 80% and the whole tax) split
  as its creator fixed it: creator / holders (cashback) / buyback-and-burn /
  liquidity. A coin created with the plain `createToken` has no tax and its
  pot goes whole to the creator or to the holders (`feesToHolders`)
- Buyback-and-burn: the burn pot buys the coin on its curve (a fee-free buy
  that raises the price and the reserve) or, once graduated, on its pool
  through the migrator, and burns what it gets — a slice at a time (a
  hundredth of the curve's virtual reserve, half a percent of the pool's
  quote side), once a block per coin, so a trade wrapped around it earns
  less than its fees; `burned` counts it, holders own `sold` less `burned`. The liquidity pot joins the pool's quote side at
  graduation (a deeper, slightly higher opening). Unspent pots leave with
  the reserve at `migrateOut` and arrive as pots on the other chain
- Graduation: once the 800M are sold out → curve trading closes and the
  200M reserve + raised quote (+ the liquidity pot) move automatically into
  a locked pool on the chain's DEX; fees end with the curve
- Holder cashback is spread over the eligible supply (every wallet, not the
  launchpad), with debts rounded up so the sum of all claims can never
  exceed what the contract holds

## Deployments

| Chain | Contract | Address |
|---|---|---|
| Base (8453) | Launchpad | [`0xDd48A36aa65142A5CF111f485C2EFB26482b74C1`](https://base.blockscout.com/address/0xDd48A36aa65142A5CF111f485C2EFB26482b74C1) — **v10**, deployed 2026-10-04 at block 52,172,805 with `script/DeployBase.s.sol`: quoted in cbLTC alone (`0xcb17…445F`, 8 decimals, 60 cbLTC virtual reserve: ~57 cbLTC of opening market cap, ~192 cbLTC raised to graduate; the native quote is off); a coin's own fees (tax up to 10% each way, the pot split creator / holders / burn / liquidity); the freeze and `migrateOut` for the move to LitVM; graduation seeds a locked Uniswap v2 pool (token/cbLTC) **in the same transaction** through `UniV2Migrator` v2 [`0xe6358F4953EcCD49a2f133FCb50661854589E2ba`](https://base.blockscout.com/address/0xe6358F4953EcCD49a2f133FCb50661854589E2ba), which never trades against a pool somebody pre-seeded; its `LaunchTokenFactory` is [`0x2925Eddca28Cf5394bDb06A100d82B78b4513786`](https://base.blockscout.com/address/0x2925Eddca28Cf5394bDb06A100d82B78b4513786). Verified on Basescan 2026-10-04 (Launchpad, factory, migrator, zap, timelock), reproducible from `contracts/verify/base-v10/` |
| Base (8453) | Launchpad v9 (**retired**) | [`0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF`](https://base.blockscout.com/address/0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF) — **do not launch on it.** Its two coins (Notus, Lester) were graduated and their pools taken in one transaction at block 52,105,142 ([`0xf1e2…8de4`](https://base.blockscout.com/tx/0xf1e2b917073cdc810b1a6a41f68eab97f8a21654f42c6e51ecd98d1bdc6e8de4)): the buyer that crossed the line starved the automatic migration of gas (the pad's `try/catch` let the graduation stand), minted Uniswap liquidity at a low price while the reserve waited on the pad, called the public `migrate`, and the v1 `UniV2Migrator` "rebalanced" that pool by buying the attacker's tokens with 143.6 (Notus) and 186.9 (Lester) of the ~192 cbLTC raised, which the attacker then withdrew; `script/pool-probe.mjs` reads the whole sequence. Both fixes are in v10: the graduation migrates atomically (no window), and the migrator never trades against a pre-seeded pool. The v9 stack: quoted in cbLTC alone (`0xcb17…445F`, 8 decimals, 60 cbLTC virtual reserve: ~57 cbLTC of opening market cap, ~192 cbLTC raised to graduate; the native quote is off); a coin's own fees (tax up to 10% each way, the pot split creator / holders / burn / liquidity); the freeze and `migrateOut` for the move to LitVM; deploy block 52,045,689; its `LaunchTokenFactory` is [`0x0287eD7e89b1D7B69Db08B16020341151E93F530`](https://base.blockscout.com/address/0x0287eD7e89b1D7B69Db08B16020341151E93F530); graduation seeded a Uniswap v2 pool (token/cbLTC) through `UniV2Migrator` v1 [`0x92329D494D4D098C95A87E381a4D60CA666edb1b`](https://base.blockscout.com/address/0x92329D494D4D098C95A87E381a4D60CA666edb1b); its timelock `0x24dc…6Dd8`, its zap `0x2C38…e756`. Verified on Basescan and Blockscout, `contracts/verify/base-v9/` |
| Base (8453) | TimelockController | [`0x8606eD231728A0977a72a9d1874219Ac7E873D04`](https://base.blockscout.com/address/0x8606eD231728A0977a72a9d1874219Ac7E873D04) — the v10 pad's only owner, 24-hour delay; proposer `0x707f…9A02`, anyone executes what is ready; treasury `0x24622320D93Da2d9c626EE469ad0C2c48a1ED7F7` |
| Base (8453) | SlipstreamZapRouter | [`0xb743CA5D9d5f1E91f98cE2AF727E39694620331a`](https://base.blockscout.com/address/0xb743CA5D9d5f1E91f98cE2AF727E39694620331a) — one-transaction ETH buys for the v10 pad, swapping on Aerodrome Slipstream's cbLTC/WETH pool (tick spacing 200) |
| Base (8453) | earlier stacks, unused | the first v9 stack at 30 cbLTC virtual (Launchpad [`0x0ba4…4955`](https://base.blockscout.com/address/0x0ba4dD0782e10a1D3946531dACC12F3797b74955), timelock `0xb97a…d92c`, `UniV2Migrator` `0x4D3C…4025`, zap `0xd740…3C55`), whose one coin its creator sold out of and relaunched here; Launchpad v7.7 [`0x2cF3…9580`](https://base.blockscout.com/address/0x2cF3e6281dddD13f4351781c584C3585e08d9580) with `UniV2Migrator` `0xcdF1…6725` and `SlipstreamZapRouter` `0x549D…9f8E`, never used, no way out for a migration; the first ZapRouter `0x07b2…b91b` on PancakeSwap v3, which found no cbLTC liquidity |
| GIWA Sepolia (91342) | Launchpad | [`0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD`](https://sepolia-explorer.giwa.io/address/0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD) — v7.1 (v7.4 redeploy pending) |
| Robinhood Chain (4663) | Launchpad | [`0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c`](https://robinhoodchain.blockscout.com/address/0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c) — v7.4, 64 quote assets |
| Robinhood Chain (4663) | NotusV4Hook | [`0x11E98A9d691B8730990d9bE1da9CD012f4e320cC`](https://robinhoodchain.blockscout.com/address/0x11E98A9d691B8730990d9bE1da9CD012f4e320cC) — v4 graduation + pool fees |
| Robinhood Chain (4663) | ZapRouter | [`0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5`](https://robinhoodchain.blockscout.com/address/0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5) — ETH zap buys |
| LitVM Liteforge (4441) | Launchpad | [`0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF`](https://liteforge.explorer.caldera.xyz/address/0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF) — v9, quoted in native zkLTC, the Base → LitVM rehearsal pad (`contracts/script/rehearse-liteforge.sh`): it holds Notus's twin [`0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF`](https://liteforge.explorer.caldera.xyz/address/0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF), migrated from Base with its 8 holders at scale 1:100 (every quote figure a hundredth, the testnet being short of zkLTC); deploy block 56,991,201; the same addresses as on Base, the deployer standing at the same nonce on both chains; `UniV2Migrator` [`0x92329D494D4D098C95A87E381a4D60CA666edb1b`](https://liteforge.explorer.caldera.xyz/address/0x92329D494D4D098C95A87E381a4D60CA666edb1b) on Lester Labs' Uniswap v2 (router `0xD56a623890b083d876D47c3b1c5343b7f983FA62`). Parked: the v7.7 pad [`0x4D3C…4025`](https://liteforge.explorer.caldera.xyz/address/0x4D3C63F873bc2aC79E529C8003321d60643a4025) (litecat and zass, the Litecoin ledger rehearsal, `UniV2Migrator` `0xE34b…1776`), the v7.6 pad `0xcdF1…6725`, the v7.5 pad `0x2cF3…9580` |
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

Points and referrals, a season-based record of every wallet's contribution
derived from the pad's events off-chain (20 points per LTC traded, bonuses on
graduations, invite links), come with LitVM and are rehearsed on its Liteforge
testnet first; the design, and the other features that come with LitVM, are in
[`POINTS.md`](POINTS.md).

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

The app has a chain switcher in the header. It offers **Base** (chain 8453,
RPC `https://mainnet.base.org`, explorer `https://base.blockscout.com`, gas in
ETH), where every coin is quoted in cbLTC; LitVM Liteforge, GIWA Sepolia,
Robinhood Chain, the Litecoin ledger (`/litecoin`) and Zcash Testnet (`/zcash`)
stay wired — addresses, assets, pages — but out of the menu (`VISIBLE_CHAINS`
in `web/lib/config.ts` lists what the menu shows; Base is the default chain).
LitVM (chain 4441, RPC `https://liteforge.rpc.caldera.xyz/infra-partner-http`,
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
forge test                       # incl. the fee model, the freeze, a cashback-solvency fuzz and the ledger-migration suite
script/rehearse-local.sh         # the migration to another chain, end to end on anvil
node script/pool-probe.mjs --rpc <nodes> --launchpad <pad> --from-block <deploy block>   # a graduated coin's pool: what went in, what it holds, every swap since
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
