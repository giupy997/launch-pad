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
  - `src/Launchpad.sol` — **v12**: factory + bonding curve (constant product
    with virtual reserves), graduation with automatic DEX migration (manual
    fallback if the DEX leg fails); on-chain token metadata (1:1 logo URI,
    website, X, Telegram, livestream URL) editable by the creator; curves
    quoted in the chain's coin or in a whitelisted ERC-20 (cbLTC on Base).
    **Fees, on the curve and on the pool alike**: the launchpad's fee —
    0.5% a side, whole to the treasury, stamped on each coin at creation
    (`FeeConfig.platformBps`, so a later `setFeeBps` touches new coins
    only) — plus the coin's own tax, up to 10% on buys and on sells, fixed
    at launch (`createTokenWithFees`, `FeeConfig`), which alone funds the
    four shares its creator fixed: the creator (`claimCreatorFees`,
    redirectable with `setFeeRecipient`), its holders as pro-rata cashback
    (`claimCashback`), a burn pot that buys the coin back on its curve or
    its pool and burns it (`buybackAndBurn`, anyone may call it) and a
    liquidity pot that joins the pool at graduation. After graduation the
    token itself takes the same rates in coins on every transfer that
    touches one of the coin's registered pools (a buy, the pool paying out;
    a sell, the pool being paid; liquidity added or removed by anyone but
    the pad's migrator), parks them in the pad (`taxTreasury`, `taxPot`),
    and anyone's `harvest` on the migrator sells them a slice at a time (all
    at once while a freeze is announced) and pays everyone their share
    (below). Wallet-to-wallet transfers pay nothing. The freeze and
    `migrateOut` for a move to another chain
    (`MIGRATION.md`); v12 itself launched clean on Base, v11 left running
    with its coins (`LAUNCH-BASE-V12.md`). The pad is
    split under the EIP-170 size limit: `LaunchpadBase.sol` (storage,
    events, errors, the shared internals), `Launchpad.sol` (the live
    surface) and `LaunchpadMigration.sol` (the migration functions, run at
    the pad's own address by delegatecall from its fallback; tooling calls
    them through `interfaces/ILaunchpadMigration.sol`); `migrationOperator`
    may run a migration into the pad without the timelock's delay. v11's
    pre-markets, RWA quote lists and `setFeeSplit` are gone (the old
    adapters and tests are parked in `contracts/legacy/`)
  - `src/LaunchToken.sol` — ERC-20 created by the launchpad; transfers locked
    until graduation; after it, every transfer the launchpad names a rate
    for (a trade with one of the coin's pools) leaves that rate with the
    launchpad, in coins, and tells it (`onTax`); `MAX_RATE` 15% caps what
    the launchpad can ever answer
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
  - `src/UniV2Migrator.sol` — v3: graduation adapter for chains whose DEX is
    Uniswap v2 (Base, LitVM): seeds the pool at the curve's final price,
    keeps the LP tokens forever and registers the pair with the pad as the
    coin's taxed pool. Nothing of the reserve is ever traded into or
    deposited at a price somebody else set: a pool pre-seeded at another
    price is nudged to ours only when that costs next to nothing, otherwise
    the reserve is parked, still the coin's, for a `seed` once the pool is
    back at our price (the v1 adapter traded the pool back to our price and
    joined it; that is how the Base v9 pools were taken, below). **`harvest`**
    (anyone): takes a slice of the fees waiting in coins at the pad — at
    most what sells for half a percent of the pool's quote side, once a
    block; everything at once while a freeze is announced — burns the burn
    share without selling it, deepens the locked liquidity with the
    liquidity share when, on the exact amounts of the sale, the pool mints
    for it (else the share is sold whole and its quote goes to the burn
    pot), sells the rest on the pool and hands the quote to the pad
    (`poolFee`): the launchpad's part to the treasury, the creator's and
    the holders' shares booked as a curve fee would be, a twentieth of the
    treasury's part to whoever called. A trade wrapped around a capped
    harvest pays the coin's tax on both legs and Uniswap's fee: it earns
    nothing. Once a freeze is announced there is no cap: both buckets sell
    whole in one call at the pool's price with no minimum, so large ones
    can be sandwiched, and the migration runbook empties the buckets before
    announcing and keeps them small through the notice (`MIGRATION.md`).
    The Uniswap router's plain swap functions do not fit these pools: with
    the coin going in (a sell, or an exact-output buy) the pair receives
    less than the router sent and reverts on its invariant; with the coin
    coming out the plain exact-input buy goes through but delivers the
    quoted amount less the rate, unchecked. Swap with the
    `...SupportingFeeOnTransferTokens` variants, as the site does;
    exact-output swaps are not supported
  - `Launchpad.migrateToken` / `migrateBalances` — the owner's or the
    migration operator's, once per coin: re-creates a coin from a frozen
    ledger — Notus on Litecoin, or an earlier pad (Base v11) — with its
    curve state, fee configuration, metadata and holder balances, funded in
    the chain's coin or in an ERC-20 quote (cbLTC), so trading continues at
    the same price; `script/MigrateFromLedger.s.sol` drives it from the file
    `litecoin/migration-snapshot.ts` or `script/snapshot-evm.mjs` writes;
    `script/rehearse-local.sh` rehearses the whole move on one anvil node
    (both quotes, owner or operator), `script/rehearse-base-fork.sh` a
    same-chain move (Base v11 → v12) on a fork of Base — built and
    rehearsed, not used: v12 launched clean
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
    blocks, `partial: true` while an old coin's history is still being read.
    Every step runs against the function's ten seconds: the rounds stop at a
    deadline with what they read, the balances get the time left, and when
    that is too little or their reads fail the last count kept is answered
    (as `partial`) rather than nothing; the browser asks again in seconds
    after a route that did not answer. `&debug=1` for what a count did and
    the nodes' last refusals. Embedded
    livestream player (YouTube/Twitch allowlist) with LIVE badges in Explore;
    creator panel to go live and redirect fees
  - `/api/*` routes and Netlify's CDN: the CDN leaves the query string out of
    its cache key unless a response says otherwise, so every route whose
    answer depends on the query (`holders`, `trades`, `img`, `points`) sends
    `netlify-vary: query`; without it every coin is served the first coin's
    answer. The browser also checks the chain and coin an answer names. The
    server's scans of Base read a keyed node first when `BASE_RPC_URLS` (the
    site's environment, comma-separated, never in the repo) names one: the
    public nodes no longer serve a coin's whole history to a server (Base's
    rations by IP and takes 500 blocks a call, publicnode only recent
    blocks), so without it a scan over old blocks can stall for good. The
    cap one node takes per `eth_getLogs` is learned per node, and a long
    span is tried in one request before being cut into ranges.
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
- Launchpad fee: 0.5% on buys and sells (max 5%; `setFeeBps` changes it
  for coins created afterwards, each coin keeping the rate it launched
  with), whole to the treasury, on the curve and on the pool; a coin's own
  tax on top, up to 10% each way, fixed at launch, split as its creator
  fixed it: creator / holders (cashback) / buyback-and-burn / liquidity,
  on the curve and on the pool. A coin created with the plain `createToken`
  has no tax, so nothing but the launchpad's fee is taken on it
  (`feesToHolders` only names whom a tax would go to)
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
  a locked pool on the chain's DEX, in the same transaction; the fees go on
  there, taken in coins by the token on every pool trade and sold by
  anyone's `harvest` (above). The pool opens **at the price the curve closed at**: the quote
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
| Base (8453) | Launchpad | [`0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5`](https://base.blockscout.com/address/0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5) — **v12**, deployed 2026-10-09 at block 52,397,620 with `script/DeployBase.s.sol`, the site's pad since: quoted in cbLTC alone (50 cbLTC virtual reserve: ~47.6 cbLTC of opening market cap, 160 cbLTC raised to graduate); the launchpad's 0.5% a side whole to the treasury and the coin's tax on the curve and on the pool, sold by anyone's `harvest`; graduation into a locked Uniswap v2 pool at the closing price through `UniV2Migrator` v3 [`0x6f3303c520dE1a74a664c3EB3045cfb0380d40B3`](https://base.blockscout.com/address/0x6f3303c520dE1a74a664c3EB3045cfb0380d40B3), which keeps its deployed code (`contracts/verify/base-v12/`): it decides the harvest's liquidity leg on an estimate, so a harvest of a coin with a liquidity share can revert on a few tens of satoshis of tax (the sizes: `MIGRATION.md`, step 2) until the next trade adds some, nothing lost — the repository's `UniV2Migrator.sol` decides it on the exact amounts (a dust harvest sends that share to the burn pot), for the LitVM pads; the migration module `LaunchpadMigration` [`0x0F413C63Cfeb342Bcd1ae176DE896b530e02B2a2`](https://base.blockscout.com/address/0x0F413C63Cfeb342Bcd1ae176DE896b530e02B2a2) behind the pad's fallback; `LaunchTokenFactory` [`0x2662A5433f360176E3555D5EEc81AC5aCE5F36f9`](https://base.blockscout.com/address/0x2662A5433f360176E3555D5EEc81AC5aCE5F36f9); `SlipstreamZapRouter` [`0x15045E01b6A38f40695EEa0BB31aE0342f7Ee810`](https://base.blockscout.com/address/0x15045E01b6A38f40695EEa0BB31aE0342f7Ee810); owned by the `TimelockController` [`0xe28f446D3a1DB105F8F9b34A65474E1F6d256f76`](https://base.blockscout.com/address/0xe28f446D3a1DB105F8F9b34A65474E1F6d256f76) (24 h, proposer `0x707f…9A02`, anyone executes). Verification: `contracts/verify/base-v12/` |
| Base (8453) | Launchpad v11 (**previous, left running**) | [`0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4`](https://base.blockscout.com/address/0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4) — **v11**, deployed 2026-10-04 at block 52,180,589 with `script/DeployBase.s.sol`, replaced by v12 on 2026-10-09 (`LAUNCH-BASE-V12.md`): not frozen, its coins (Notus, Lester) trade there still, on Uniswap and through the pad's contract on the explorer (the site no longer shows it), their cashback and creator fees claimable there; quoted in cbLTC alone (`0xcb17…445F`, 8 decimals, 60 cbLTC virtual reserve: ~57 cbLTC of opening market cap, ~192 cbLTC raised to graduate; the native quote is off); a coin's own fees (tax up to 10% each way, the pot split creator / holders / burn / liquidity); the freeze and `migrateOut` for the move to LitVM; graduation seeds a locked Uniswap v2 pool (token/cbLTC) **in the same transaction, at the price the curve closed at** (190.48M coins against the raise, 9.52M locked in the pad) through `UniV2Migrator` v2 [`0x8fB7f1D18F4b2ECC79da94aBF51f95B93E07d218`](https://base.blockscout.com/address/0x8fB7f1D18F4b2ECC79da94aBF51f95B93E07d218), which never trades against a pool somebody pre-seeded; its `LaunchTokenFactory` is [`0xac34DF8Cfb7Cd1d28441C5f17e294B07fb93EE4a`](https://base.blockscout.com/address/0xac34DF8Cfb7Cd1d28441C5f17e294B07fb93EE4a). Verification: `contracts/verify/base-v11/` |
| Base (8453) | first v12 stack (**unused**) | Launchpad [`0x272971D65Ae335De8A3f07d66a86540E2d58C5CF`](https://base.blockscout.com/address/0x272971D65Ae335De8A3f07d66a86540E2d58C5CF), deployed 2026-10-09 at block 52,397,444: its timelock `0x5643…8858` was given forge's stand-in sender (`0x1804…1f38`, no key exists) as proposer, so nobody can ever drive it — no fee, treasury or migrator change, no freeze. The pad would trade for ever as it stands; it is simply not used. Its `UniV2Migrator` `0x9b18…dbCd`, zap `0xD4E9…b094`, module `0xd765…e213`, factory `0xD01E…fDeD`. The deploy scripts now read the proposer from the broadcast itself and refuse the stand-in |
| Base (8453) | Launchpad v10 (**retired, unused**) | [`0xDd48A36aa65142A5CF111f485C2EFB26482b74C1`](https://base.blockscout.com/address/0xDd48A36aa65142A5CF111f485C2EFB26482b74C1) — deployed earlier on 2026-10-04 (block 52,172,805) with the atomic graduation and the v2 migrator but before the opening-price change (its pool would open 4.8% under the closing price); no coin was ever created on it. Its `UniV2Migrator` `0xe635…E2ba`, zap `0xb743…331a`, timelock `0x8606…3D04`, factory `0x2925…3786`; verified on Basescan, `contracts/verify/base-v10/` |
| Base (8453) | Launchpad v9 (**retired**) | [`0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF`](https://base.blockscout.com/address/0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF) — **do not launch on it.** Its two coins (Notus, Lester) were graduated and their pools taken in one transaction at block 52,105,142 ([`0xf1e2…8de4`](https://base.blockscout.com/tx/0xf1e2b917073cdc810b1a6a41f68eab97f8a21654f42c6e51ecd98d1bdc6e8de4)): the buyer that crossed the line starved the automatic migration of gas (the pad's `try/catch` let the graduation stand), minted Uniswap liquidity at a low price while the reserve waited on the pad, called the public `migrate`, and the v1 `UniV2Migrator` "rebalanced" that pool by buying the attacker's tokens with 143.6 (Notus) and 186.9 (Lester) of the ~192 cbLTC raised, which the attacker then withdrew; `script/pool-probe.mjs` reads the whole sequence. Both fixes are in v10: the graduation migrates atomically (no window), and the migrator never trades against a pre-seeded pool. The v9 stack: quoted in cbLTC alone (`0xcb17…445F`, 8 decimals, 60 cbLTC virtual reserve: ~57 cbLTC of opening market cap, ~192 cbLTC raised to graduate; the native quote is off); a coin's own fees (tax up to 10% each way, the pot split creator / holders / burn / liquidity); the freeze and `migrateOut` for the move to LitVM; deploy block 52,045,689; its `LaunchTokenFactory` is [`0x0287eD7e89b1D7B69Db08B16020341151E93F530`](https://base.blockscout.com/address/0x0287eD7e89b1D7B69Db08B16020341151E93F530); graduation seeded a Uniswap v2 pool (token/cbLTC) through `UniV2Migrator` v1 [`0x92329D494D4D098C95A87E381a4D60CA666edb1b`](https://base.blockscout.com/address/0x92329D494D4D098C95A87E381a4D60CA666edb1b); its timelock `0x24dc…6Dd8`, its zap `0x2C38…e756`. Verified on Basescan and Blockscout, `contracts/verify/base-v9/` |
| Base (8453) | v11 TimelockController | [`0xeDCe189855E9298C3f5b937fE9Ffe8D5261B9EB2`](https://base.blockscout.com/address/0xeDCe189855E9298C3f5b937fE9Ffe8D5261B9EB2) — the v11 pad's only owner, 24-hour delay; proposer `0x707f…9A02`, anyone executes what is ready; treasury `0x24622320D93Da2d9c626EE469ad0C2c48a1ED7F7` |
| Base (8453) | v11 SlipstreamZapRouter | [`0x072a77dC2a770504A1DA17e2fB6814C9cFf85254`](https://base.blockscout.com/address/0x072a77dC2a770504A1DA17e2fB6814C9cFf85254) — one-transaction ETH buys for the v11 pad, swapping on Aerodrome Slipstream's cbLTC/WETH pool (tick spacing 200) |
| Base (8453) | earlier stacks, unused | the first v9 stack at 30 cbLTC virtual (Launchpad [`0x0ba4…4955`](https://base.blockscout.com/address/0x0ba4dD0782e10a1D3946531dACC12F3797b74955), timelock `0xb97a…d92c`, `UniV2Migrator` `0x4D3C…4025`, zap `0xd740…3C55`), whose one coin its creator sold out of and relaunched here; Launchpad v7.7 [`0x2cF3…9580`](https://base.blockscout.com/address/0x2cF3e6281dddD13f4351781c584C3585e08d9580) with `UniV2Migrator` `0xcdF1…6725` and `SlipstreamZapRouter` `0x549D…9f8E`, never used, no way out for a migration; the first ZapRouter `0x07b2…b91b` on PancakeSwap v3, which found no cbLTC liquidity |
| GIWA Sepolia (91342) | Launchpad | [`0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD`](https://sepolia-explorer.giwa.io/address/0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD) — v7.1 (v7.4 redeploy pending) |
| Robinhood Chain (4663) | Launchpad | [`0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c`](https://robinhoodchain.blockscout.com/address/0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c) — v7.4, 64 quote assets |
| Robinhood Chain (4663) | NotusV4Hook | [`0x11E98A9d691B8730990d9bE1da9CD012f4e320cC`](https://robinhoodchain.blockscout.com/address/0x11E98A9d691B8730990d9bE1da9CD012f4e320cC) — v4 graduation + pool fees |
| Robinhood Chain (4663) | ZapRouter | [`0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5`](https://robinhoodchain.blockscout.com/address/0xfd0C942E3DB34672715B862A8e19838bC9EDa7B5) — ETH zap buys |
| LitVM Liteforge (4441) | Launchpad | [`0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F`](https://liteforge.explorer.caldera.xyz/address/0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F) — **v11** rehearsal pad, deployed 2026-10-04 at block 57,741,789 with `script/DeployLitVM.s.sol`: quoted in native zkLTC, opened with a 0.05 zkLTC virtual reserve (a curve raised 0.16 zkLTC to graduate, so graduations could be rehearsed on faucet money); from 2026-10-10 a coin created on it opens with **0.9375 zkLTC** of virtual reserve and raises **3 zkLTC** to graduate (`setQuoteAsset(0, 9.375e17)`, the deployer's call; the coins created before keep their 0.05; the mainnet pad will open with its own figure), owned by the deployer (a rehearsal pad); `UniV2Migrator` v2 [`0xD45e4011Dae718aAF95DB5BdCA8e7Ee3ca8F413F`](https://liteforge.explorer.caldera.xyz/address/0xD45e4011Dae718aAF95DB5BdCA8e7Ee3ca8F413F) on Lester Labs' Uniswap v2 (router `0xD56a623890b083d876D47c3b1c5343b7f983FA62`); both verified on the Caldera Blockscout on 2026-10-06 (`contracts/verify/liteforge-v11/`). Season 0 of the points runs on it, and the Base → LitVM migration was rehearsed into it on 2026-10-05 (`rehearse-liteforge.sh`, scale 1:1000, ALL PASS): Notus's twin [`0x616e…3e99`](https://liteforge.explorer.caldera.xyz/address/0x616e01ca4370433aE7690d0A5EF891ddbb553e99) and Lester's [`0x0d81…aC09`](https://liteforge.explorer.caldera.xyz/address/0x0d8144Ac2Fb62132786fe9671446e583385aaC09), same holders, same price. Rehearsed again on 2026-10-09, with Notus graduated on Base, into a second v11 rehearsal pad [`0x0CF2207D3260BF737671a6855769358701E7873f`](https://liteforge.explorer.caldera.xyz/address/0x0CF2207D3260BF737671a6855769358701E7873f) (deploy block 59,320,583; `UniV2Migrator` v2 [`0x072a…5254`](https://liteforge.explorer.caldera.xyz/address/0x072a77dC2a770504A1DA17e2fB6814C9cFf85254)): ALL PASS, 64 Notus holders with their pool at the frozen price, 10 Lester holders on the curve — twins [`0x0fFe…05BD`](https://liteforge.explorer.caldera.xyz/address/0x0fFe2C4E267b679f0d42292a5168a1e8507305BD) and [`0x24c5…A7C3`](https://liteforge.explorer.caldera.xyz/address/0x24c57dF9802285a148E7074278C00ce1ddA3A7C3). Each pad holds the root of the snapshot it took, so the next rehearsal takes a fresh pad (run the script without `TARGET`). Parked: the v9 rehearsal pad [`0xcaB7…42EF`](https://liteforge.explorer.caldera.xyz/address/0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF) (deploy block 56,991,201, Notus's twin [`0xFe23…eCdF`](https://liteforge.explorer.caldera.xyz/address/0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF) migrated from Base at scale 1:100 with the v1 migrator `0x9232…db1b`), the v7.7 pad [`0x4D3C…4025`](https://liteforge.explorer.caldera.xyz/address/0x4D3C63F873bc2aC79E529C8003321d60643a4025) (litecat and zass, the Litecoin ledger rehearsal, `UniV2Migrator` `0xE34b…1776`), the v7.6 pad `0xcdF1…6725`, the v7.5 pad `0x2cF3…9580` |
| LitVM Liteforge (4441) | TimelockController | [`0xFaFc00D9f9cD8A82874D05dFd17D6230dB320C87`](https://liteforge.explorer.caldera.xyz/address/0xFaFc00D9f9cD8A82874D05dFd17D6230dB320C87) — owns an older, parked pad: the v7.7 `0x4D3C…4025` (listed above), since block 56,260,690; not the v11 rehearsal pad above, which the deployer owns. A 10-minute delay for rehearsals on the testnet (a LitVM mainnet pad's timelock takes `DeployTimelock.s.sol`'s 48-hour default); proposer `0x707f…9A02`, anyone executes what is ready |

### Governance

A pad's owner is meant to be a `TimelockController` (OpenZeppelin): every owner
call — the launchpad's fee (for coins created afterwards), treasury,
migrator, quote assets, taxed pools, the migration operator, the freeze and
`migrateOut`, the ledger migration — is scheduled first and can only run
after the delay, so any change is visible on chain before it takes effect.
The proposer may schedule and cancel; anyone may execute an operation once
it is ready. Base v12's timelock (`0xe28f…6f76`, Deployments) was deployed
inside `contracts/script/DeployBase.s.sol`, in the same run as the pad, with
a 24-hour delay, the deployer (`0x707f…9A02`) as proposer and the open
executor role; it owns the pad from its first block.
`contracts/script/DeployTimelock.s.sol` deploys one on its own and hands it a
pad (`LAUNCHPAD`); its 48-hour default is for the LitVM mainnet pad, which
the deployer owns for the migration day and the timelock takes right after
(`MIGRATION.md`). The migration script speaks the timelock's language
(`MODE=schedule`, then `MODE=execute`). On Liteforge the pad the site uses
(`0x39D1…ef7F`, a v11 rehearsal pad) is owned by the deployer; the timelock
there (`0xFaFc…0C87`, 10 minutes) owns an older, parked pad (v7.7). A pad no
timelock owns is the deployer key's. The migration of the Litecoin ledger to
LitVM mainnet, step by step: [`litecoin/MIGRATION.md`](litecoin/MIGRATION.md).

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
mainnet pad opens its zkLTC curves with the same virtual reserve as Base's
cbLTC ones — 50 from v12 on (160 zkLTC raised to graduate; v11 opened with
60, decided 2026-10-05, 192 to graduate); the Liteforge rehearsal pad runs
at 0.05 so that graduations can be tried on faucet money.
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

Signing: the deployer key lives in a Foundry keystore encrypted with a password
(`cast wallet import notus --interactive`, once per machine), never in a file in
clear: every `forge script` and `cast send` takes `--account notus` and asks for
the password. Deploy to GIWA Sepolia:

```bash
cd contracts && source .env && forge script script/Deploy.s.sol --rpc-url giwa_sepolia --account notus --broadcast
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
