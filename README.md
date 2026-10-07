# Notus

**https://notus-pad.fun** — a token launchpad on Base, quoted in cbLTC:
Litecoin wrapped by Coinbase, one LTC in custody for every token, with a
public proof of reserves. What it is, how keys are handled and how to reach
us: [notus-pad.fun/about](https://notus-pad.fun/about); email notuspad@gmail.com.

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
  - `/` Explore: King of the Hill (the coin on its curve closest to
    graduating, with the shape of its day, its price, volume and holders),
    the Contenders behind it, then every coin under Trending / New /
    Graduated tabs with a sort menu (recently graduated, last trade, market
    cap, 24h volume, bonding progress, newest, oldest), a search box and a
    choice of cards or rows; every figure computed once per coin from the
    on-chain list (multicall, 5s refresh) and the day's trades, each coin
    formatted in its own quote
  - `/create`: token creation with logo (1:1) and social links, a searchable
    pair picker over all 64 quote assets (grouped Pre-IPO / ETFs & commodities
    / Stocks, with official logos) and the irrevocable fee-destination choice
  - `/token/[address]`: a header with the contract address first (copied
    in a tap), the creator, when the coin was launched, its buy and sell tax,
    the pool fee once graduated and the day's volume, with the market cap and
    the 24h change on the right; curve stats and progress bar; buy/sell box
    with on-chain quotes, automatic approve and 1% slippage guard; price
    chart; under it two tabs, Trades and Holders. The trades come from
    `/api/trades` (the pad's events scanned once on the server, cached at the
    edge, the browser then reading only the blocks mined since into its
    localStorage cache; the browser scans by itself when the server does not
    answer). The holders come from `/api/holders` (`web/lib/holders/count.ts`):
    the coin's Transfer logs read from the chain, in one `eth_getLogs` where
    a node takes the whole span and in rounds of ranges otherwise, then every
    balance in one multicall, contracts (the pad, the pool) named rather than
    counted; the addresses seen, the block read up to and the last count
    live in the Netlify Blobs store `holders`, so a request reads only new
    blocks, `partial: true` while an old coin's history is still being read,
    `&debug=1` for what a count did and the nodes' last refusals. Embedded
    livestream player (YouTube/Twitch allowlist) with LIVE badges in Explore;
    creator panel to go live and redirect fees
  - `/api/*` routes and Netlify's CDN: the CDN leaves the query string out of
    its cache key unless a response says otherwise, so every route whose
    answer depends on the query (`holders`, `trades`, `img`, `points`) sends
    `netlify-vary: query`; without it every coin is served the first coin's
    answer. The browser also checks the chain and coin an answer names.
  - `/api/health`: one answer for an uptime monitor, 200 while Base's nodes
    and the Blobs store answer, 503 otherwise, with every check's result (the
    testnet's nodes and the points service are reported, not decisive)
  - `/swap`: ETH ↔ token swaps on the curve; token → token routed
    through ETH in two transactions
  - `/bridge`: chain-aware — on GIWA, in-app ETH deposits Ethereum
    Sepolia → GIWA via the OP Stack Standard Bridge (L1StandardBridge
    `0x77b2ffc0F57598cAe1DB76cb398059cF5d10A7E7`); on Robinhood Chain,
    live Ethereum/Robinhood balances and a link to the Arbitrum
    canonical bridge (the official route per Robinhood docs)
  - `/profile`: connected wallet holdings and created tokens

## Curve parameters

- Total supply: 1B per token; 800M sold on the curve, 200M reserved for the
  DEX, of which 190.48M seed the pool and 9.52M stay locked in the pad for
  good (the curve's virtual share: below)
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
  a locked pool on the chain's DEX, in the same transaction; fees end with
  the curve. The pool opens **at the price the curve closed at**: the quote
  that goes in (the raise and the liquidity pot) against as many coins as
  that price says, 190.48M of the 200M reserve, and the rest of the reserve
  stays locked in the pad for good (`lockedAtGraduation`), the curve's
  virtual share of the supply, as Pons does. Put in the pool as well, those
  coins would open it 4.8% under the closing price (192 / 200M against 252 /
  250M virtual), as the retired v9 and v10 pads on Base did. The liquidity
  pot deepens the opening without lifting it
- Holder cashback is spread over the eligible supply (every wallet, not the
  launchpad), with debts rounded up so the sum of all claims can never
  exceed what the contract holds

## Deployments

| Chain | Contract | Address |
|---|---|---|
| Base (8453) | Launchpad | [`0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4`](https://base.blockscout.com/address/0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4) — **v11**, deployed 2026-10-04 at block 52,180,589 with `script/DeployBase.s.sol`: quoted in cbLTC alone (`0xcb17…445F`, 8 decimals, 60 cbLTC virtual reserve: ~57 cbLTC of opening market cap, ~192 cbLTC raised to graduate; the native quote is off); a coin's own fees (tax up to 10% each way, the pot split creator / holders / burn / liquidity); the freeze and `migrateOut` for the move to LitVM; graduation seeds a locked Uniswap v2 pool (token/cbLTC) **in the same transaction, at the price the curve closed at** (190.48M coins against the raise, 9.52M locked in the pad) through `UniV2Migrator` v2 [`0x8fB7f1D18F4b2ECC79da94aBF51f95B93E07d218`](https://base.blockscout.com/address/0x8fB7f1D18F4b2ECC79da94aBF51f95B93E07d218), which never trades against a pool somebody pre-seeded; its `LaunchTokenFactory` is [`0xac34DF8Cfb7Cd1d28441C5f17e294B07fb93EE4a`](https://base.blockscout.com/address/0xac34DF8Cfb7Cd1d28441C5f17e294B07fb93EE4a). Verification: `contracts/verify/base-v11/` |
| Base (8453) | Launchpad v10 (**retired, unused**) | [`0xDd48A36aa65142A5CF111f485C2EFB26482b74C1`](https://base.blockscout.com/address/0xDd48A36aa65142A5CF111f485C2EFB26482b74C1) — deployed earlier on 2026-10-04 (block 52,172,805) with the atomic graduation and the v2 migrator but before the opening-price change (its pool would open 4.8% under the closing price); no coin was ever created on it. Its `UniV2Migrator` `0xe635…E2ba`, zap `0xb743…331a`, timelock `0x8606…3D04`, factory `0x2925…3786`; verified on Basescan, `contracts/verify/base-v10/` |
| Base (8453) | Launchpad v9 (**retired**) | [`0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF`](https://base.blockscout.com/address/0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF) — **do not launch on it.** Its two coins (Notus, Lester) were graduated and their pools taken in one transaction at block 52,105,142 ([`0xf1e2…8de4`](https://base.blockscout.com/tx/0xf1e2b917073cdc810b1a6a41f68eab97f8a21654f42c6e51ecd98d1bdc6e8de4)): the buyer that crossed the line starved the automatic migration of gas (the pad's `try/catch` let the graduation stand), minted Uniswap liquidity at a low price while the reserve waited on the pad, called the public `migrate`, and the v1 `UniV2Migrator` "rebalanced" that pool by buying the attacker's tokens with 143.6 (Notus) and 186.9 (Lester) of the ~192 cbLTC raised, which the attacker then withdrew; `script/pool-probe.mjs` reads the whole sequence. Both fixes are in v10: the graduation migrates atomically (no window), and the migrator never trades against a pre-seeded pool. The v9 stack: quoted in cbLTC alone (`0xcb17…445F`, 8 decimals, 60 cbLTC virtual reserve: ~57 cbLTC of opening market cap, ~192 cbLTC raised to graduate; the native quote is off); a coin's own fees (tax up to 10% each way, the pot split creator / holders / burn / liquidity); the freeze and `migrateOut` for the move to LitVM; deploy block 52,045,689; its `LaunchTokenFactory` is [`0x0287eD7e89b1D7B69Db08B16020341151E93F530`](https://base.blockscout.com/address/0x0287eD7e89b1D7B69Db08B16020341151E93F530); graduation seeded a Uniswap v2 pool (token/cbLTC) through `UniV2Migrator` v1 [`0x92329D494D4D098C95A87E381a4D60CA666edb1b`](https://base.blockscout.com/address/0x92329D494D4D098C95A87E381a4D60CA666edb1b); its timelock `0x24dc…6Dd8`, its zap `0x2C38…e756`. Verified on Basescan and Blockscout, `contracts/verify/base-v9/` |
| Base (8453) | TimelockController | [`0xeDCe189855E9298C3f5b937fE9Ffe8D5261B9EB2`](https://base.blockscout.com/address/0xeDCe189855E9298C3f5b937fE9Ffe8D5261B9EB2) — the v11 pad's only owner, 24-hour delay; proposer `0x707f…9A02`, anyone executes what is ready; treasury `0x24622320D93Da2d9c626EE469ad0C2c48a1ED7F7` |
| Base (8453) | SlipstreamZapRouter | [`0x072a77dC2a770504A1DA17e2fB6814C9cFf85254`](https://base.blockscout.com/address/0x072a77dC2a770504A1DA17e2fB6814C9cFf85254) — one-transaction ETH buys for the v11 pad, swapping on Aerodrome Slipstream's cbLTC/WETH pool (tick spacing 200) |
| Base (8453) | earlier stacks, unused | the first v9 stack at 30 cbLTC virtual (Launchpad [`0x0ba4…4955`](https://base.blockscout.com/address/0x0ba4dD0782e10a1D3946531dACC12F3797b74955), timelock `0xb97a…d92c`, `UniV2Migrator` `0x4D3C…4025`, zap `0xd740…3C55`), whose one coin its creator sold out of and relaunched here; Launchpad v7.7 [`0x2cF3…9580`](https://base.blockscout.com/address/0x2cF3e6281dddD13f4351781c584C3585e08d9580) with `UniV2Migrator` `0xcdF1…6725` and `SlipstreamZapRouter` `0x549D…9f8E`, never used, no way out for a migration; the first ZapRouter `0x07b2…b91b` on PancakeSwap v3, which found no cbLTC liquidity |
| GIWA Sepolia (91342) | Launchpad | [`0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD`](https://sepolia-explorer.giwa.io/address/0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD) — v7.1 (v7.4 redeploy pending) |
| Robinhood Chain (4663) | Launchpad | [`0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c`](https://robinhoodchain.blockscout.com/address/0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c) — v7.4, 64 quote assets |
| Robinhood Chain (4663) | NotusV4Hook | [`0x11E98A9d691B8730990d9bE1da9CD012f4e320cC`](https://robinhoodchain.blockscout.com/address/0x11E98A9d691B8730990d9bE1da9CD012f4e320cC) — v4 graduation + pool fees |
| Robinhood Chain (4663) | ZapRouter | [`0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5`](https://robinhoodchain.blockscout.com/address/0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5) — ETH zap buys |
| LitVM Liteforge (4441) | Launchpad | [`0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F`](https://liteforge.explorer.caldera.xyz/address/0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F) — **v11** rehearsal pad, deployed 2026-10-04 at block 57,741,789 with `script/DeployLitVM.s.sol`: quoted in native zkLTC with a **0.05 zkLTC virtual reserve** (a curve raises 0.16 zkLTC to graduate, so graduations can be rehearsed on faucet money; the mainnet pad will open with a real one), owned by the deployer (a rehearsal pad); `UniV2Migrator` v2 [`0xD45e4011Dae718aAF95DB5BdCA8e7Ee3ca8F413F`](https://liteforge.explorer.caldera.xyz/address/0xD45e4011Dae718aAF95DB5BdCA8e7Ee3ca8F413F) on Lester Labs' Uniswap v2 (router `0xD56a623890b083d876D47c3b1c5343b7f983FA62`); both verified on the Caldera Blockscout on 2026-10-06 (`contracts/verify/liteforge-v11/`). Season 0 of the points runs on it, and the Base → LitVM migration was rehearsed into it on 2026-10-05 (`rehearse-liteforge.sh`, scale 1:1000, ALL PASS): Notus's twin [`0x616e…3e99`](https://liteforge.explorer.caldera.xyz/address/0x616e01ca4370433aE7690d0A5EF891ddbb553e99) and Lester's [`0x0d81…aC09`](https://liteforge.explorer.caldera.xyz/address/0x0d8144Ac2Fb62132786fe9671446e583385aaC09), same holders, same price; the pad holds that snapshot's root, so the next rehearsal takes a fresh pad (run the script without `TARGET`). Parked: the v9 rehearsal pad [`0xcaB7…42EF`](https://liteforge.explorer.caldera.xyz/address/0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF) (deploy block 56,991,201, Notus's twin [`0xFe23…eCdF`](https://liteforge.explorer.caldera.xyz/address/0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF) migrated from Base at scale 1:100 with the v1 migrator `0x9232…db1b`), the v7.7 pad [`0x4D3C…4025`](https://liteforge.explorer.caldera.xyz/address/0x4D3C63F873bc2aC79E529C8003321d60643a4025) (litecat and zass, the Litecoin ledger rehearsal, `UniV2Migrator` `0xE34b…1776`), the v7.6 pad `0xcdF1…6725`, the v7.5 pad `0x2cF3…9580` |
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
DEX — see [litecoin/README.md](litecoin/README.md#the-road-to-litvm). The
mainnet pad opens its zkLTC curves with the same 60 of virtual reserve as
Base's cbLTC ones (192 zkLTC raised to graduate), decided 2026-10-05; the
Liteforge rehearsal pad runs at 0.05 so that graduations can be tried on
faucet money.
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
# the Base v10 stack end to end on a fork — zap, graduation, the Uniswap pool, trading on it: RUN_FORK_LIVE=true forge test --match-contract LiveBase -vv
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
