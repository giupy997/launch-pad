# Launching v12 on Base, clean

The v11 pad on Base (`0xEfbB…5f4`) takes fees on the curve alone: once a coin
graduates, nothing of a pool trade reaches its creator, its holders, its
burn or the treasury. v12 taxes every swap on the coin's pool too, with the
split the coin chose at launch, and keeps the launchpad's own 0.5% a side for
the treasury. A deployed pad cannot change, so v12 is a new stack, launched
clean: **v11 stays as it is** — not frozen, its coins trading where they
trade today (Lester on its curve, Notus in its Uniswap pool), its cashback
and creator fees claimable — and the site moves to v12, where Notus and
Lester are created again from the Create page, with the taxes their creator
chooses. The v11 pad stays reachable from the site's legacy page.

(The machinery for moving coins from one pad to another on the same chain —
snapshot, `migrateOut`, `migrateToken` in cbLTC, an operator — was built and
rehearsed for this and stays in the repository, `script/rehearse-base-fork.sh`
proving it on a fork of Base. It is not used here; it serves the move to
LitVM mainnet, `MIGRATION.md`.)

Variables for the day, in an env file outside the repo (`~/notus-v12.env`):

```bash
V11_PAD=0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4
CBLTC=0xcb17C9Db87B595717C857a08468793f5bAb6445F
V12_PAD=0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5        # deployed 2026-10-09
V12_MIGRATOR=0x6f3303c520dE1a74a664c3EB3045cfb0380d40B3
V12_ZAP=0x15045E01b6A38f40695EEa0BB31aE0342f7Ee810
V12_TIMELOCK=0xe28f446D3a1DB105F8F9b34A65474E1F6d256f76
V12_MODULE=0x0F413C63Cfeb342Bcd1ae176DE896b530e02B2a2
V12_FACTORY=0x2662A5433f360176E3555D5EEc81AC5aCE5F36f9
V12_BLOCK=52397620
```

## 0. Before

- `forge test` green on the v12 contracts; the Base fork test of the real
  router run from the VPS (`RUN_FORK_LIVE=true FORK_RPC=<keyed node> forge test
  --match-path test/V12Pool.fork.t.sol -vv`).
- v12 tried for real on Liteforge first (step 4 below, done ahead): a coin
  graduated on Lester Labs' Uniswap v2, bought and sold through the pool,
  harvested.

## 1. Deploy v12

```bash
cd ~/launch-pad/contracts && source .env
forge script script/DeployBase.s.sol --rpc-url base --account notus --broadcast
```

The script's defaults: cbLTC the only quote, **50 cbLTC of virtual reserve**
(160 cbLTC to graduate, ~47.6 cbLTC of market cap at launch, ~840 at
graduation; v11 opened with 60), the launchpad's fee 0.5%, the treasury
`0x2462…D7F7`, a 24-hour timelock owning the pad from its first block, no
migration operator. It prints every address: write them in the env file.

Verify each contract on Blockscout from this checkout with its constructor
arguments (the header of `DeployBase.s.sol`): Launchpad (treasury),
LaunchpadMigration and LaunchTokenFactory (no arguments; `pad.MIGRATION_MODULE()`,
`pad.tokenFactory()`), UniV2Migrator (pad, router), SlipstreamZapRouter (pad,
router, weth), TimelockController (delay, proposers, executors, 0). Keep the
standard-input JSONs in `contracts/verify/base-v12/`: they are the deployed
sources, and this checkout has moved on since (the harvest in
`UniV2Migrator.sol`, below).

## 2. The site

In `web/lib/config.ts`, for Base: `LAUNCHPAD_ADDRESS` → v12, `LAUNCHPAD_DEPLOY_BLOCK`
→ the deploy block, `ZAP_ROUTER` → the new zap, `PAD_VERSION` → 12, and the
v11 pad into `LEGACY_LAUNCHPADS` (address, deploy block 52,180,589, label
"Launchpad v11"). The README's Deployments table gets the v12 row. Commit,
push; Netlify deploys. The Create page now launches on v12; the legacy page
(`/legacy`) lists the v11 coins with their state, a sell box for the ones on
their curve, the cashback and creator-fee claims, and the links to their
pools.

## 3. Notus and Lester, again

From the Create page, as the first time, each with its tax and split (the
0.5% launchpad fee is on top, whole to the treasury). Same tickers are fine:
the v12 pad has never seen them. Tell holders of the old ones where the new
ones are, and that the old ones keep trading on v11 and on Uniswap.

## 4. Liteforge (testnet), with the 100 zkLTC

A v12 pad there, to try graduation, pool trades and the harvest on a real
Uniswap v2 (Lester Labs') before Base:

```bash
cd ~/launch-pad/contracts && source .env
ROUTER=$(cast call 0xE34b882BD48D3b13A92C5A7C99469485d1761776 "router()(address)" --rpc-url litvm_testnet)
UNIV2_ROUTER=$ROUTER NATIVE_VIRTUAL=500000000000000000 forge script script/DeployLitVM.s.sol --rpc-url litvm_testnet --account notus --broadcast
```

(0.5 zkLTC of virtual reserve: a curve graduates with 1.6 zkLTC, so many
graduations fit in the 100.) Then, from the explorer or `cast`: create a
taxed coin (`createTokenWithFees`), buy it through graduation, swap on its
pair, and run the pool rehearsal on it:

```bash
printf '{"launchpad":"%s","migrator":"%s","quote":"0x0000000000000000000000000000000000000000"}\n' "$PAD" "$MIGRATOR" > ../litecoin/migration/rehearsal-target.json
TOKEN=<the coin> SINGLE_SIGNER=true QUOTE_IN=10000000000000000 forge script script/rehearsal/RehearseV12Pool.s.sol --rpc-url litvm_testnet --account notus --broadcast
```

`POOL PASS`: a taxed buy and sell on the pool, a harvest that paid the
treasury, a free transfer. The site's Liteforge entry stays on the v11
rehearsal pad (Season 0 of the points runs on it) until decided otherwise.

## Afterwards

- v11 keeps running untouched: nothing of it is owed a transaction. The
  Lester cashback (0.2254 cbLTC) and any creator fees are claimed from the
  legacy page whenever.
- On v12 the pool fees run: anyone may `harvest` a coin (the site has the
  button; the caller is tipped), a capped slice a block — both buckets
  whole in one call, uncapped, once a freeze is announced, which is why
  `MIGRATION.md` empties the buckets first — the treasury gets 0.5% of
  every trade, the creator's and the holders' shares accrue as before, the
  burn share is burned, the liquidity share deepens the locked pool.
- The v12 migrator keeps the code it was deployed with
  (`contracts/verify/base-v12/`). For a coin with a liquidity share, a
  harvest of a few tens of satoshis of tax can revert there (the sizes:
  `MIGRATION.md`, step 2): it decides whether the pool mints for that share
  on an estimate, which at some sizes says yes while the share's cbLTC
  rounds to nothing, and the pair's mint refuses. Nothing moves and nothing
  is lost; the next trade adds tax and the harvest goes through. The
  repository's `UniV2Migrator.sol` now decides that leg on the exact
  amounts (a dust harvest sends the share to the burn pot), for the LitVM
  pads.
- The move to LitVM mainnet, when it comes, starts from v12 (`MIGRATION.md`);
  the v11 coins can be moved the same way if ever wanted, the machinery
  having been rehearsed for exactly that (`script/rehearse-base-fork.sh`).
