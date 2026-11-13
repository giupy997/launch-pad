# Security

## Reporting a vulnerability

Please report privately, never in a public issue:

- GitHub's private vulnerability reporting on this repository (Security →
  Report a vulnerability), or
- email: notuspad@gmail.com (the project's address, the one in security.txt).

Say what is affected (a contract address, a page of the site, a service), how
to reproduce it, and what you believe the impact is. You will get an answer
within 72 hours. A report on the live contracts is answered first: those hold
other people's money. No bounty programme exists at this time.

## What is in scope

- The contracts under `contracts/src/` as deployed on Base (the v12 stack:
  Launchpad, LaunchpadMigration, LaunchTokenFactory, UniV2Migrator,
  SlipstreamZapRouter, the TimelockController that owns the pad) — addresses
  and verification in `README.md` and `contracts/verify/base-v12/`.
- The site (`web/`) at notus-pad.fun, including its API routes and edge
  functions.
- The points service (`points/`) and the watch (`ops/`).

Out of scope: the parked experiments under `parked/` (not built, run or
deployed), rehearsal pads on test networks, and third-party protocols the
contracts call (Uniswap v2, Aerodrome, the chains' bridges) or the site talks
to (RPC providers, WalletConnect, Netlify).

## How the deployment is governed

- The pad on Base is owned by a TimelockController with a 24-hour delay:
  every owner action (fee, treasury, migrator, quote assets, a freeze, the
  migration operator) is scheduled in the open on chain and can only run a
  day later; anyone may execute a ready operation. Since 2026-10-12 the only
  proposer and canceller is a Safe 2-of-3 (`0x934A…d8F4`); the deployer's key
  alone can no longer schedule or cancel anything.
- The retired v11 pad on Base keeps its settings for good: its timelock has
  had no proposer since 2026-10-12.
- A read-only watch (`ops/watch.mjs`) reports on Telegram every operation
  scheduled, executed or cancelled, every role change, every owner-only event
  on the pads, and every deploy of the site, within a minute.
- The deployer's key lives in a Foundry keystore on one machine with
  key-only SSH; it signs rehearsals, the daily operations of the Liteforge
  rehearsal pad, deploys, and the execution of ready timelock operations.
  The same key is today one of the Safe's three owners: the owner means to
  replace it there with a key that never touches that machine, so that the
  machine, compromised with the keystore's password, holds no signature of
  the two; `check-base-v12.sh` reports the Safe's `isOwner` for the key until
  then.

## Independent reviews

No formal audit has been commissioned. Two independent security reviews were
received; both are answered in full in the repository's history.

| Date | Reviewer | Findings | Status |
|---|---|---|---|
| 2026-10-09 | zauth (external report on the contracts, the site and the parked Zcash code) | 4 Medium, 1 High (a Zcash viewing key handled in the parked code) | Mediums fixed in `5ee0e68`; the High closed on 2026-10-10 by parking the Zcash and Litecoin code out of every build (`51235fb`) |
| 2026-10-12 | a LitVM community member (technical security assessment of commit `27959e9`: contracts, migration, site, points, operations, npm supply chain; the report is published by the site at [notus-pad.fun/security/security-assessment-2026-10-12.pdf](https://notus-pad.fun/security/security-assessment-2026-10-12.pdf), the file in `web/public/security/`) | 4 High, 4 Medium, 3 Low, no Critical | see below |
| 2026-10-19 | the same reviewer: a re-check of the remediation (the named commits, `main`, CI, the live site, the Base deployment with migrator v5) | H-02, M-02, M-03 and H-03's production exposure closed; H-01 and L-01 verified in code, to be confirmed on the deployed LitVM pad; M-01 and H-04 kept open; eight points of hygiene (the dev-tooling advisories, `npx` in CI, branch protection, dependency review, secret scanning, static analysis, the wallet-bundle wording, two stale live-fork tests, host-level verification of the units) | answered the same day, finding by finding below: M-01 open for the next pad; the repository settings enabled by the owner the same evening (a ruleset on `main` against deletion and force pushes, secret scanning with push protection, Dependabot and malware alerts, private vulnerability reporting); the units' exposure measured on the server (L-02); the live-fork tests run from the server against the v12 stack, 21 of 21 passed |

### The 2026-10-12 assessment, finding by finding

| ID | Finding | Status |
|---|---|---|
| H-01 | The migration root is informational: the operator chooses holders and balances with no proof against it | Fixed in code 2026-10-12: the root is the Merkle tree of the snapshot (a leaf per coin as recorded, a leaf per holder's balance; OpenZeppelin's standard leaves), committed once through the timelock; `migrateToken` and `migrateBalances` verify every coin and every balance against it, so the operator delivers what the snapshot says and nothing else; the snapshot tool (`script/merkle.mjs`) and the migration script (`script/MerkleTree.sol`) build the same tree, cross-checked by the fixture test, and anyone can rerun the tool on the frozen source and compare the root. Lands with the next pad (the LitVM mainnet pad, deployed from this code); Base v12 keeps its module, which only matters for a migration *into* Base, none planned. To be confirmed on the deployed LitVM pad at its deploy (the reviewer's re-check of 2026-10-19): the root set through the timelock, a delivery verified against it |
| H-02 | Once a freeze is announced, `harvest` sells a coin's whole tax bucket in one call, with no cap and no minimum | Fixed in code 2026-10-12: the rush mode is gone; a harvest is a capped slice (a 0.5% move of the pool, which a trade wrapped around one slice cannot profit from) on any day, a freeze announced included, and the notice (a day at least) is time enough for the keeper (`contracts/script/ops/harvest.sh`, named in `MIGRATION.md`) to empty any bucket; tests cover a sandwich under an announced freeze and the keeper's loop. On Base this is `UniV2Migrator` v4 (`0xaB95…fEf1`), deployed on 2026-10-12 from this code and verified on Basescan; the Safe scheduled `setMigrator` the same night (two signatures) and it executed on 2026-10-14 at block 52,573,727, before any coin graduated on v12 (a coin keeps the migrator it graduated through). The internal review of 2026-10-13 found that v4's pacing (a slice a block) still let a run of slices be fronted: the price moved once, every later slice sold into it; v5 paces harvest and buyback five minutes apart per coin, so the move has to be held in the open for minutes a slice; deployed on Base on 2026-10-14 (`0x6007…3434`, block 52,573,869, from this code, verified on Basescan) and set on the pad by the Safe the same way (scheduled on 2026-10-14 with two signatures, executed on 2026-10-15 at block 52,618,587), before the first graduation; the LitVM pad deploys with it |
| H-03 | Known High npm advisories in the site's dependencies | Fixed 2026-10-12: Next.js 16.3.8 (the image-optimization SSRF, GHSA-cjq9-62q9-8jv4), nanoid and source-map-js updated, axios and ws pinned to their fixed releases through `overrides` (axios sits in Coinbase's wallet SDK, which the site never instantiates; `ws` in WalletConnect's nested viem, a Node-only module that is never in the browser bundle, while the WalletConnect connector itself is instantiated when `NEXT_PUBLIC_WC_PROJECT_ID` is set, as it is on the site: the wording the reviewer's re-check of 2026-10-19 corrected). `npm audit --omit=dev` reports no High or Critical advisory; the remaining Moderate ones are in the same connector graph and in development tooling, and CI fails on any new High in production dependencies. Development tooling, re-checked on 2026-10-19: the eight High advisories there are one chain, `braces` and `micromatch` (stack exhaustion on deeply nested glob patterns), reached through `eslint-config-next` and Tailwind 3; no fixed release of `braces` exists and the fix npm names is Tailwind 4, a migration of its own. They run in lint and build only, on patterns this repository writes, never on the site: accepted on 2026-10-19, reviewed with every dependency update and on 2027-01-19 at the latest. `brace-expansion` 1.1.16 under eslint's `minimatch` 3 (an unbounded expansion; the one of the eight with a fixed release in its line) is moved to 1.1.21 by an override. 2026-10-22: three advisories on Next.js 16.0.0 to 16.4.0 (GHSA-2464-fhr4-w9xw, an unauthenticated remote code execution in the image-optimization API with SVG files; GHSA-673q-mjm6-r5xr, the same through `use cache` functions returning typed arrays; GHSA-p3m5-59mp-jv5r, a denial of service in server actions) and two on `follow-redirects` 1.16.0 (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c, credential headers kept across origins; under Coinbase's SDK in the wallet connectors). The site uses neither `use cache` nor server actions and does not allow SVG through `next/image`; patched the same day all the same: Next.js 16.4.2 (published 2026-10-15, seven days old that evening, as the hold wants) with `eslint-config-next` 16.4.2, and `follow-redirects` moved to 1.16.1 by an override. The production audit is clean again; the seven High in development tooling are the accepted ones above. 2026-10-24: GHSA-mrhx-c7xc-m3w5 on `zod` below 4.6.6 (memory exhaustion while validating oversized constrained collections; published 2026-10-01, in npm's database from 2026-10-24, where it turned CI red on `b978b98`). `zod` sat in three places in the production graph: Reown's `appkit-wallet` (the WalletConnect modal's embedded-wallet frame, which pins 3.22.4 upstream still), `@wagmi/connectors` (3.25.76, which its code never imports) and `h3` with `zod-validation-error` (4.4.3); none of them validates anything a stranger sends the site. Moved to 4.6.7 (published 2026-10-12) everywhere by an override the same day: `appkit-wallet`'s schemas construct under zod 4 (its module loaded in Node to check), the gate and the production audit are clean. 2026-11-02: two more, both turning CI red on `40359dd`: GHSA-mrwp-f3q8-3g9p on `follow-redirects` 1.16.0 to 1.16.1 (sensitive headers kept across redirects when the array came from another realm; the override of 2026-10-22 had it at 1.16.1), and GHSA-vcc3-ghjq-m6fr with GHSA-qr28-fpjm-wq7f on `decode-uri-component` up to 0.5.0 (a denial of service on malformed percent-encoded input; under `query-string` in WalletConnect's `utils`, which parses the URLs of its own pairing links, not what a stranger sends the site). `follow-redirects` moved to 1.16.2 (published 2026-10-25) and `decode-uri-component` to 0.5.1 (2026-10-23) by overrides the same day, both past the seven-day hold; the lock written by npm 10, the production audit clean, the 1,030 registry signatures verified |
| H-04 | No npm policy in the repository: loose ranges, no `.npmrc`, no immutable install in the deployment notes | Fixed 2026-10-12: `web/.npmrc` (no lifecycle script ever runs, exact versions saved, `min-release-age=7` for npm 11 and later), every direct dependency pinned exactly, `packageManager` pinned, every install in the docs and on the servers is `npm ci --ignore-scripts`. `strict-peer-deps` is not set: WalletConnect's nested `valtio` declares a React 18 peer, which fails the immutable install under that flag; the build and the site run on React 19 regardless. Re-check of 2026-10-19: the hold was inert under npm 10 (`packageManager` pinned 10.9.7, which does not read `min-release-age`), so npm 11.21.1 is now the npm the lock is installed with in CI (installed by exact version and asserted, with `min-release-age` read back as 7, before `npm ci`) and named by `packageManager`; Netlify installs the very lock CI has checked, with the npm its image ships (10), so the hold holds on every deploy through CI. The lock is written by npm 10: the one npm 11 wrote on 2026-10-19 left out the nested optional peers npm 10 expects, npm 10's `npm ci` refused it as out of sync, and every Netlify build from 2026-10-19 to 2026-10-22 failed while the site stayed on the build before (restored 2026-10-23); npm 11 installs an npm 10 lock as it is; CI calls the repository's own scripts (`npm run typecheck`, `lint`, `test`) rather than `npx`, which fetches the latest release when a binary is missing. The `strict-peer-deps` deviation is a policy exception: approved by the owner on 2026-10-19, reviewed on 2027-01-19 or as soon as WalletConnect's `valtio` declares a React 19 peer, whichever comes first |
| M-01 | The LitVM deploy script leaves the pad under the deployer's key until a later script hands it to a timelock | Narrowed in code 2026-10-12: `script/DeployLitVM.s.sol` deploys the TimelockController in the same broadcast and hands the pad to it (48-hour delay by default, `PROPOSER` the Safe), as `DeployBase.s.sol` does; a rehearsal pad on the testnet stays the deployer's only with `DEPLOYER_OWNED=true`, said in so many words. Open after the reviewer's re-check of 2026-10-19: a Foundry broadcast is several transactions, so between the pad's creation and `transferOwnership` the pad is the deployer's for a few seconds, in which only the deploying key itself could act. For the next pad, before the LitVM mainnet deploy: a deployer contract creates the pad, its migrator and the timelock and hands the pad over inside one transaction. On Base v12 that window is past |
| M-02 | The points indexer appends events before it writes its checkpoint: a crash in between replays them | Fixed 2026-10-12: every event is counted once by transaction and log index, however often it is read or written; a crash-replay test covers it |
| M-03 | A two-step token-to-token swap page could spend the wallet's own native balance beyond the sale's proceeds | Fixed 2026-10-12 by removing the page: it was never linked from the site and listed only native-quoted curves, so it showed nothing on Base (cbLTC-quoted) and worked only on the Liteforge rehearsal pad |
| M-04 | No CI, no protected-file rules, `forge fmt --check` failing | Fixed 2026-10-12: `.github/workflows/ci.yml` (actions pinned to commits, read-only token, immutable install with no lifecycle script, registry signatures, production-dependency audit, types, lint, unit tests, build; forge fmt and the contract tests), `CODEOWNERS`, this file, the contracts formatted. Branch protection on `main` is a repository setting the owner enables. Re-check of 2026-10-19: static analysis runs in CI from `.github/workflows/analysis.yml`, CodeQL over the site and the points service and Slither over the contracts, on every push, pull request and once a week, the findings in the repository's Security tab (code scanning) rather than in a failing build, since Slither's eight High items are the migration module's view of storage the pad writes (Automated analysis below); branch protection on `main`, secret scanning with push protection and Dependabot alerts are repository settings, enabled by the owner; dependency review acts on pull requests, which this repository does not use (one owner, pushes to `main`), so the lock is reviewed in each dependency commit instead |
| L-01 | The ERC-20 buy credits the amount requested, not the amount received | Fixed in code 2026-10-12: the buy and the migration's quote pull measure the pad's balance around the transfer and revert unless the delta is the amount (a fee-on-transfer mock test on both). Lands with the next pad; on Base v12 the only quote asset is cbLTC, a standard token, and a quote asset can only be added through the timelock. To be confirmed on the deployed LitVM pad at its deploy (the reviewer's re-check of 2026-10-19) |
| L-02 | The systemd units carry no sandboxing directives | Fixed 2026-10-14, installed on the server the same day: each service runs as its own system user (`notus-watch`, `notus-points`), with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` (the keystore, `.env`, the operations and `/etc/notus` hidden besides), `PrivateTmp`, `PrivateDevices`, `ProtectProc=invisible`, the kernel and cgroup protections, `RestrictAddressFamilies`, `@system-service` syscalls, no capabilities, `UMask=0077`, memory and task limits; state under `/var/lib/<service>`; installed by `ops/deploy/install-units.sh`. The internal review of 2026-10-13 had added the reason it mattered: the two shared one user, so the one service exposed to the network could read the watch's bot token from `/proc` and write the checkout both ran from. Host-level verification (the reviewer's re-check of 2026-10-19): `systemd-analyze security` on the server, run by the owner on 2026-10-19, rates both units 1.6 "OK" (systemd's scale runs from 0, safe, to 10; under 3 is OK). What it still marks: `MemoryDenyWriteExecute`, which Node's JIT cannot take; `RootDirectory`, a chroot the units do without; `SupplementaryGroups=notus`, deliberate, so the services read the checkout; and the `@privileged` and `@resources` call groups `@system-service` leaves open. `RemoveIPC=yes` added to both units the same day |
| L-03 | The site's Content Security Policy allows inline scripts | Open: a nonce-based policy needs a request-time nonce through Next.js middleware; planned, low priority, no HTML sink exists in the application |

### Automated analysis (2026-10-16)

Slither 0.11.6 and Mythril 0.24.8 were run on `contracts/src` at `ae57549`, the code of the
contracts on Base (`UniV2Migrator.sol` unchanged since the v5 deploy at `9f0b102`), with the five
fuzz tests at 3,000 runs each (15,000 cases, all passing). Nothing calls for a change to the
deployed contracts.

- **Slither** (102 detectors, 77 results): every High and Medium read against the code. The
  eight High/High `uninitialized-state` and the twelve optimisation items are the migration
  module's view of storage that the pad writes (the module runs by `delegatecall`; `forge inspect`
  shows the pad's and the module's storage layouts identical, 39 slots). The four High/Medium
  reentrancy items are calls to the pad's own token, to WETH and to Uniswap's pair and factory
  from functions under `nonReentrant`, and `zapBuyCurve`'s refund of a caller's surplus, guarded
  the same way. The rest are design choices (five-minute cooldowns on `block.timestamp`, partial
  destructuring of return values) or false positives of the analysis.
- **Mythril** (two transactions deep, 30 minutes per contract, twice: from the constructor, and
  on the runtime code with unconstrained storage, the immutables made storage in a copy for the
  purpose): no exploitable path. Its seven integer-underflow reports are the compiler's own
  guarded arithmetic (the ABI decoder's calldata-size check, the reading of a storage string), its
  "unprotected ether withdrawal" is the zap router returning its whole balance to the caller of
  `zapBuyCurve`, a router meant to hold nothing between transactions; the reentrancy and
  multiple-call reports are the zap's calls to the pad and the DEX under its guard. Coverage of
  the migrator and the pad stays partial by construction: a call into a contract the engine does
  not hold answers without data, so the cross-contract paths (harvest, graduation, buyback) are
  covered by the Foundry tests, not by Mythril.
- **For the next pad**, three hardenings noted, none a vulnerability: `harvest` asserting that
  `takeTax` handed over exactly what it sells and deposits (`toSell == sellT + deepenT`), the
  address parameters of `MigratorUpdated`, `TreasuryUpdated` and `MigrationOperatorUpdated`
  indexed, and the zap router's `receive()` open to the launchpad alone.

### The 2026-10-19 review

A fresh read of the contracts as deployed on Base (`Launchpad`, `LaunchpadBase`,
`LaunchpadMigration`, `LaunchToken`, `LaunchTokenFactory`, `UniV2Migrator` v5, `ZapRouter`,
`SlipstreamZapRouter`, at `d33a7ab`, unchanged since the v5 deploy), of the deploy script, the
operations scripts, the watch, the CI and the site's chain configuration, with the chain read
back at block 52,813,390: `check-base-v12.sh` answers `ALL PASS` through a public node, and the
only `WARN` is the deployer's key still an owner of the Safe (governance above). No finding
against the deployed code: the fee arithmetic, the cashback accumulator, the graduation in one
piece, the parked reserve, the harvest's exact-amount liquidity leg and the freeze's exceptions
read as the tests say. What the review adds is operational, around the contracts.

| ID | Finding | Status |
|---|---|---|
| L-04 | The treasury (`0x2462…D7F7`) is an externally owned account: the launchpad's share of every curve trade and every harvest is paid straight to a single key, which then holds the fee income of the pad (1.35 cbLTC and 0.076 ETH on 2026-10-19) | Open, the owner's decision: `setTreasury` to the Safe 2-of-3 (`timelock.sh safe-calldata set-treasury`), so the income needs two signatures to move; the treasury is read, never hard-coded, by the site and the scripts |
| L-05 | The earlier pads on Base are still open to coin creation, and the deployer's key alone drives four of them: the first v12 stack (`0x2729…C5CF`, 0 coins) has a timelock nobody can drive and stays open for ever; v10 (`0xDd48…74C1`, 0 coins), v9 (`0xcaB7…42EF`, 2 coins) and the first v9 stack (`0x0ba4…4955`, 2 coins) have the deployer's key as the only proposer of their 24-hour timelocks; the v7.7 pad (`0x2cF3…9580`, 0 coins) is owned by that key directly, with no timelock. None holds money the site points at, but each is a verified `Launchpad` that can mint coins under the project's name, and the watch reads none of their timelocks | Open, the owner's decision, no urgency: close creation where it can be closed (`announceFreeze` through the three old timelocks; every quote asset set to 0 on v7.7, which has no freeze), then revoke the deployer's key from the three timelocks (`timelock.sh revoke` with `TIMELOCK` pointed at each), so a key compromised on the VPS (governance above) can touch nothing but v12's execution; until then, their addresses go in `NOTUS_WATCH_TIMELOCKS` |
| L-06 | A ticker is not unique on the pad: `createToken` takes any name and symbol (only a migrated ledger ticker is claimed once), and the site marks no coin as the project's own. Two third-party coins already live on v12 (`LITVMCOOL`, `MUR`, created after 2026-10-15, untraded). Anyone can create a `NOTUS` before or after the owner's, and Explore would list both alike | Open, before the launch: publish the official addresses with the launch (`LAUNCH-BASE-V12.md`, the site's About, the pinned post) and have the site flag them by address, a list beside `HIDDEN_TOKENS` in `web/lib/config.ts`, so an impostor's page reads as one |
| I-01 | The pad on Robinhood Chain (`0x4A84…001c`, v7.4, 4 coins: the pre-markets, 1% fee) is a mainnet pad on the code before v9, owned directly by a key (`0x87D7…D825`, no timelock), holding no ETH; wired in `APP_CHAINS`, out of the menu | Open, the owner's decision: say in the README whether it is retired, and if it is, take it out of `APP_CHAINS` and off the key's keychain; nothing on it moves the project's money |
| I-02 | For the next pad: the curve-side slice of `buybackAndBurn` (half a percent of the virtual reserve, a block) is safe against a wrapped trade because every coin pays the launchpad's fee both ways, 0.5% a side on v12, stamped at launch. A pad whose `feeBps` is lowered under 25 would let a coin taxed less than the difference be bought and sold around its own buyback at a profit, a block at a time, until the pot is gone | Noted for the next pad: size the curve slice from the coin's stamped rate. The reasoning holds for the repository's two-hundredth; on v12's hundredth it does not, M-13 (2026-11-13) |

### The first live graduation (2026-10-25)

Notus (`0x4CFC…0fE5`) graduated on the v12 pad at block 53,079,599, in the transaction of the
buy that closed its curve (`0x26e5…efb9`, 3.33M gas): `Graduated(160 cbLTC)`, the migrator's
`PoolSeeded` and the pair's `Mint` in one piece, 190.96M coins against 160.406 cbLTC (the raise
and the coin's liquidity pot), the pool open at the curve's closing price to the digit and
9.04M coins locked in the pad for good. The pool (`0xf940…7133`) was then read as a custody
question: the migrator holds every LP token but the 1,000 wei Uniswap burns at the first mint,
and nothing can move them but `unlock`, which the launchpad alone may call, from `migrateOut`,
which is the timelock's (24 hours, the Safe 2-of-3 proposing) and needs the pad frozen first
(`announceFreeze`, the watch's alert). The migrator has no owner, no `selfdestruct`, no
`delegatecall`, no approval; its runtime code on Base is the repository's `UniV2Migrator.sol`
byte for byte, the four immutables apart (the pad, Uniswap's v2 router `0x4752…aD24` and factory
`0x8909…8eC6`, WETH `0x4200…0006`). Its public entry points are `seed`, which only moves a
reserve parked at graduation (none here), and `harvest`, capped at half a percent of the pool's
quote side every five minutes and paying the treasury, the creator, the holders and the burn pot
through the pad, the caller's tip a twentieth of the treasury's part. The token taxes every
pool trade and exempts the pad's and the migrator's own moves; no pool trade can skim the pair,
since the migrator's transfers to it are consumed by its own swap in the same call. Sniping was
there (four buys in the block after graduation, through outside routers) and changed nothing.
No finding. One operational note: twenty minutes after the graduation no `harvest` had run
(`nextHarvestAt` 0), the keeper on the VPS was not running; the buckets wait, nothing is lost.

### Base's block time (2026-11-11)

Base made a block every 2 s until block 53,556,119 (2026-11-05 17:59:45 UTC) and makes one every
0.2 s from the next. Nothing in the repository measured it: the figure was a constant in the
site's configuration and a default in the operations script. Found on 2026-11-11, from the
site showing Notus a day's volume of 9 cbLTC where the pool had traded ten times that.

What the deployed contracts count in blocks, read again at the new pace: the freeze
(`announceFreeze(atBlock)`, `frozen()`), which is a block the owner chooses, and the pad's
`buybackAndBurn`, one slice of a curve coin's burn pot a block. `UniV2Migrator` v5 paces its
harvest and its buyback by `block.timestamp` (five minutes) and is untouched; the timelock's
delay is seconds.

| ID | Finding | Status |
|---|---|---|
| M-05 | `timelock.sh announce-freeze` turned the hours of notice into a block at 2 s a block (`BLOCK_SECONDS` defaulting to 2), and `MIGRATION.md` gave the freeze as "100,000 blocks (~55 h)". At 0.2 s a block the script's 24-hour notice lands 2.4 hours after the execution and the document's figure in 5.5 hours: a freeze far shorter than announced, which the pad cannot take back once it has landed. Latent: no freeze was ever announced on v12 (`freezeBlock` 0) | Fixed 2026-11-11: the script measures the chain's pace over its last 5,000 blocks at the moment it picks the block and prints it (`BLOCK_SECONDS` remains as an override), and stops if it cannot measure; the document gives the notice in hours and says never to count the blocks by hand. Dry run that day: 31 hours of notice after a 24-hour delay is 990,000 blocks, where the old arithmetic gave 99,000 |
| L-07 | The site counted a day as 43,200 blocks and a trade's age at 2 s a block (`BLOCK_SECONDS`, `blockSeconds`): from 2026-11-05 the cards' and the coin page's "24h volume" and "24h change" covered 2.4 hours, the ages of trades without a read timestamp were shown ten times older, and a coin's history from the server reached back 28 hours instead of 11.6 days. Figures shown, no funds | Fixed 2026-11-11: `/api/trades` measures the chain's pace (two blocks' timestamps, kept ten minutes) and takes the day and a coin's twelve days of history from it, the long spans in one request to the archive node; the constants are 0.2; `/api/health` compares each chain's pace with the configured one (`pace:base`, `pace:liteforge`, not vital) and the watch reports a difference on Telegram |

The pad's `buybackAndBurn` is as it was in blocks, one slice (half a percent of the curve's
virtual reserve) a block, and ten times closer in time: a run of slices that took twenty
seconds takes two. The slice's size, which is what a trade wrapped around one cannot profit
from, does not depend on the pace; the time a position has to be held across a run does, and
is shorter. The pad cannot be changed; a curve coin's burn pot is its tax on curve trades, a
fraction of a cbLTC on every coin of the pad at that date. Noted, not changed.

### A migrated coin's identity (2026-11-13)

The migration into a pad named a coin by its ticker: `migrateToken` reserved the hash of the
symbol (`migratedTicker`) and refused a second coin with it, and the tools found a coin's token
by its ticker. That is the Litecoin ledger's rule, where the ticker was the coin. On a launchpad
a ticker names nothing (L-06): read on 2026-11-13, nine tickers of the Base v12 pad's fifty
coins are shared, `NOTUS` (`0xf679…132e`, on its curve with 1.35 cbLTC, created before the
graduated `0x4CFC…0fE5`) and `LESTER` among them, and 54 tickers of the Liteforge pad's 408.
Found while planning a move of the Liteforge pad to the current stack.

| ID | Finding | Status |
|---|---|---|
| M-06 | A coin could not be migrated beside another with its ticker. `snapshot-evm.mjs` stopped at the first shared ticker ("migrate one of them by hand"), so the dry run of the Base to LitVM move would not have produced a file; with a hand-made file the pad gave the ticker to whichever coin the operator delivered first and reverted the other (`TickerMigrated`), leaving that coin's holders on the frozen pad with its reserve already taken out. The uniqueness of the ticker was also what kept two coins' leaves apart: two coins alike in every field have one leaf, and a holder's balance, which names its coin by that leaf, would have proved itself for either. Latent: no migration into a v12 pad was ever run on a live chain, and the pad it concerns is the one not yet deployed | Fixed 2026-11-13 in the repository, for the next stack: `LedgerCoin` carries an `id`, the coin's address on its source pad as 32 bytes (the hash of its ticker for a ledger's coin), part of its leaf; the pad gives one token to an id (`migratedCoin`, `CoinMigrated`) and refuses a coin without one. `snapshot-evm.mjs` writes it and lets shared tickers through with a warning, `merkle.mjs` refuses an id named twice, `MigrateFromLedger.s.sol` and the rehearsal find a coin's token by its id, and the map the site serves is keyed by the source address. Tests: two coins of one ticker each migrate with their own holders, a holder of one is not delivered to the other, an id migrates once whatever its ticker, a coin without an id is refused (`Migration.t.sol`); `rehearse-local.sh` moves two coins under one ticker end to end, in both quotes |

### The 2026-11-13 review

A review of the whole repository in five parts (the pad's contracts, the migrator and the
zap, the migration tooling and the operations scripts, the site and its routes, the points
service and the watch), each read independently and each finding reproduced with a test or
a run before it was written here (the throwaway tests are `contracts/test/_review_*`, kept
out of the repository). Nothing that moves funds was found in the contracts, deployed or
not. What was found is in the watch, the site's trade feed, the tooling for the move to
LitVM, and the points rules. Every finding below is open unless its status says otherwise.

**The deployed stack.** The solvency of the v12 pad was read from the chain the same day:
what it holds in cbLTC against every claim on it (curve reserves, pots, creator fees, the
cashback of every address that ever held a coin with a holders' share), see the line under
the table once the read completes. The wrapped-buyback test was run against the v12 sources
as deployed.

| ID | Finding | Status |
|---|---|---|
| M-07 | The watch reads the head from one node and the logs from another (`ops/watch.mjs`, `chainPass`/`readLogs` through viem's fallback transport) and then sets `lastBlock` to the head. A public node behind the first answers blocks past its own head with an empty list and no error (measured 2026-11-13 on base.drpc.org), so a timelock operation scheduled in those blocks is never reported, not now and not as the "executable" reminder: the 24-hour delay is worth exactly what the chance of seeing the operation in time is worth. Reproduced with two local nodes, the second 40 blocks behind: a `setTreasury` to a stranger went unreported through two passes and `lastBlock` moved past it. The points indexer solved the same problem on 2026-11-12 (the head and the logs in one JSON-RPC batch to one node, a range believed only if that node's head is past it, `web/lib/points/scan.ts`); the watch has no such guard | Open |
| M-08 | A long Telegram message is cut at 3,900 characters from the end, and the watch renders an operation's calls first and its id, its transaction and the Safe's cancel calldata last. A `scheduleBatch` whose first call carries a long argument list (a `setQuoteAssets` of 170 entries, every argument printed whole) pushes a second call, a `setTreasury`, off the end with the cancel data: the owner sees a harmless first call and cannot cancel from the message. Reproduced: 3,913 characters, the siren call, the id and the cancel data all gone | Open |
| M-09 | `/api/trades` keeps the trades it served in memory under a key of the chain, the token and the pairs named (`web/app/api/trades/route.ts`), not the coin named for each pair nor its side, and verifies no pair against the chain. A request from anyone naming a pad coin of theirs on Notus's pair, or Notus on its pair with the side flipped, shares the key with the site's own request and appends swaps decoded as its coin's, or as Notus's at a nonsense price, to the trades the site then serves everyone for the cache's hour: the most traded coin, the contenders, the volume sort and a coin's chart and feed can be set from a browser. Reproduced against a stubbed node: the site's fourth request returned the stranger's two trades beside the real one | Open |
| M-10 | The snapshot values a graduated coin's pool at the migrator's share of the LP supply (`snapshot-evm.mjs`, `pairQuote * lpOurs / lpTotal`), and `migrateOut` delivers less: Uniswap's `burn` first mints the protocol's fee LP to `feeTo`, which is set on Base's factory (`0x9bD2…168c`). On a fork of Base at block 57,041,641 the file said 130.78 cbLTC for Lester's pool and `migrateOut` paid 130.57: 0.206 cbLTC short, 0.0004 on Notus, growing with every trade since the pool's last mint. On the day the receiving pad asks the operator for the file's figure, so the operator pays the difference or the coin stalls at `migrateToken`; `rehearse-base-fork.sh` has been topping it up from the treasury and calling it rounding | Open |
| M-11 | The snapshot calls every address with code a contract and refuses the run (or, with `--allow-contract-holders`, migrates them all): a wallet that delegated (EIP-7702, 23 bytes of code) is a wallet whose key exists on LitVM. Of 47 current holders of Notus and Lester checked on 2026-11-13, 12 are delegated wallets. On the day either dozens of false contracts to triage by hand, or real pools and routers minted to dead addresses on LitVM beside the wallets. `script/cashback.mjs` makes the distinction; the snapshot does not | Open |
| M-12 | `MIGRATION.md` step 1's deploy command passes neither `PROPOSER` nor `MIGRATION_OPERATOR`, where the text beside it says the Safe is the proposer and the deployer the operator. `DeployLitVM.s.sol` then makes the deployer's key the sole proposer of the mainnet pad's 48-hour timelock, the posture Base left behind on 2026-10-12, and step 6 reverts `NotOperator` for 48 hours. The same document calls the stillness "a few hours" where its own delays (`migrate-out` prepared only once the freeze has landed, 24 h; `set-root` on LitVM, 48 h, scheduled only once the file exists) make it two days at least | Open |
| M-13 | On the v12 pad as deployed, the curve-side slice of `buybackAndBurn` is a hundredth of the virtual reserve (the repository has a two-hundredth since c9a7ae0, 2026-10-13). Run against the deployed sources: on a coin with a burn share and its own tax under 40 bps a side, a buy, the buyback and a sell in one transaction (three calls, none nested: `nonReentrant` does not apply) take the slice at a profit, 0.044 cbLTC a block at 25 bps and 0.12 at 1 bps with 21.5 cbLTC of capital, until the pot is empty; at 50 bps the trade loses. The pad cannot change. No coin on v12 is exposed today (read 2026-11-13: the one coin with a burn share and a lower tax has a tax of zero, so its pot never fills; three are at 50/50, where the trade loses); any coin created on v12 with a burn share and a tax of 1 to 40 bps would be. I-02's reasoning, that the launchpad's 0.5% fee alone makes the slice safe, holds for the two-hundredth and not for the hundredth | Open: the site to refuse, or warn on, the creation on v12 of a coin with `burnBps > 0` and a tax under 50 bps a side; I-02 corrected by this row |
| L-08 | Coins bought for the migrator before graduation (`buyWithQuoteFor(token, amount, 0, migrator)`, open to anyone) count in `eligibleSupply` and stay in it: at graduation the migrator becomes ineligible but only the pool's balance is taken off (`_registerPool`), not the migrator's. Every holders' share is then spread over more than the eligible wallets hold and the remainder stays in the pad, claimable by no one. In the test 10 cbLTC bought that way on a 300 cbLTC graduation left holders 78% of their share. Safe direction (never insolvent), costs the doer the coins; a creator could shrink their holders' share on purpose. Both versions | Open for the repository: in `_doMigrate`, take the migrator's balance off `eligibleSupply` as `_registerPool` does the pool's |
| L-09 | A referral binding is stamped with the head the service last read (`indexer.ts`, `bindReferral`), not the chain's: while the node is dark the chain runs on and the binding is back-dated, paying the invitee's and the inviter's bonus on trades made before the invite; a freshly restarted service that has not finished a pass stamps the block before the season. POINTS.md says "from that block on, never to the past". Reproduced: a trade at block 5,000, an invite accepted at 9,000 stamped 1,100, both bonuses paid | Open |
| L-10 | `points/service.ts` counts the per-invitee rate limit (5 a minute) before the signature is verified, on an address the request names: five unsigned claims naming a wallet lock that wallet out of accepting its own invite, from one IP, repeated at will. Reproduced against the real service | Open |
| L-11 | The coin routes (`/:chain/coin/…/trades`, `…/holders`, `/:chain/trades`) stamp every trade's block time per request with no in-flight de-duplication and are reachable through Caddy without the site's cache or rate limit: 50 concurrent requests for a coin with 60 trade blocks made 3,000 `eth_getBlockByNumber` calls to the node the indexer shares, enough for the node's throttle to stall the indexer's own passes | Open |
| L-12 | `store.ts` ignores `writeSync`'s return (a short write on a full disk is not an exception) and repairs only a torn last line: a torn line followed by appends throws at the next start, and systemd restarts the service every ten seconds until the file is repaired by hand, with the health route reporting nothing before | Open |
| L-13 | `readLogs` in the watch tests viem's generic `shortMessage` ("Invalid parameters were provided…") for the node's refusal of a range, so the chunk never halves on a real refusal and halves on a rate limit. After a downtime longer than one chunk on a node that takes 2,000 blocks a call the watch fails every pass and reports its blindness after five minutes but never recovers without a restart | Open |
| L-14 | A state file the watch cannot parse is taken for a first run, which is quiet: role grants, delay changes and the pads' owner-only events in the re-read range produce no message and a scheduled operation only fills `pending`. Reproduced: a `RoleGranted(PROPOSER, stranger)` and a scheduled `setTreasury(stranger)` 200 blocks back gave "watch avviato" and "operazioni in attesa: 1" | Open |
| L-15 | The watch shows an unknown address as its first and last four hex characters, the form a known one takes minus its label: an address made to share those eight characters with the Safe's (2^32 work) reads as the Safe without a name | Open |
| L-16 | `script/cashback.mjs` prints the node's URL, key included, on its first failure: its `unhandledRejection` handler never fires for a rejected top-level `await` in a module, Node prints the whole error. `snapshot-evm.mjs` installs both handlers and cuts URLs to their host; the report does not | Open |
| L-17 | `harvest.sh` and `cashback.sh` trap `INT` and `TERM` with the clean-up alone, so the script goes on after the signal with its password file, or its holder list, removed: the keeper looks alive and harvests nothing; the push loops on an empty list, sending `claimCashbackFor(token, [])` each turn while the signer can sign | Open |
| L-18 | `MigrateFromLedger.s.sol` in timelock mode salts each operation with its position in the plan recomputed from the pad's state, so once the first operation has executed the next one gets a new salt and a new id: `execute` finds nothing, `schedule` schedules the same calls again a delay away, and the orphan stays executable by anyone for ever (reproduced in a test: 7 coins, 3 operations, one executed, 0 found). Direct mode, the runbook's, resumes correctly | Open |
| L-19 | `writeMigrated` runs in forge's simulation: a run without `--broadcast` writes a map of token addresses that do not exist, and a real run writes addresses the factory's next nonces would give, which anyone's `createToken` between simulation and inclusion shifts. The site serves that map as `/migrated/<chain>.json` | Open |
| L-20 | Coins sent to a graduated coin's pair before the migrator seeds it (a coin graduated with no migrator set, whose transfers are open) are priced into the first mint, and after a nudge the dust path deposits everything parked at the parked ratio: the pool opens under the curve's closing price (5% under with 10M donated coins in the test), the surplus coins in the pool rather than with the treasury as `_seed`'s NatSpec says. A griefing with no profit to the griefer, and no live coin affected. Both versions | Open |
| L-21 | A ticker named `constructor`, `toString` or any property of `Object.prototype` stops the snapshot (`feeOverrides` is a plain object, the lookup finds the prototype's), before the announcement, by anyone, for 0.5% | Open |
| L-22 | `OFFICIAL_TOKENS[base.id]` is empty: the badge L-06 asked for is in the code and marks nothing. Two coins named Notus from the same creator, three Notus Cat, two Lester and four Chikun live on the pad and nothing on the site tells them apart but the address | Open: the project's addresses to be written there |

Smaller: the pad's native payout in `claimCashbackFor` copies the payee's return data, so a delegate that returns 190 KB costs the batch about three times `PUSH_GAS`, not once (correct the comment or call in assembly); `_checkPath` in the zap takes a 40-byte path no v3 router executes (43 is the shortest; the transaction reverts whole, the caller's gas alone); harvest and buyback have each their own five-minute timer where the comment reads as one; `parseSnapshot` in `merkle.mjs` quotes a 16-digit run inside a description (unused export); invalid UTF-8 in a name is rewritten to U+FFFD on the way; `PRIVATE_KEY` is refused only on chains 1 and 8453; the snapshot is taken on the unsafe head; `timelock.sh` reads a saved operation's chain from the addresses file, not from the operation; `MIGRATION.md` still says the harvest is uncapped after the freeze (H-02 closed that); the pad without v12's getters (v11) cannot be snapshotted, a revert being read as a node failure; the curve sells one wei of coin for one quote unit and takes no fee under 200 units; a long name, ticker or description is rendered whole on a coin's page; the Caddyfile still answers `desk.notuspad.com`.

**The points leaderboard and the giveaway.** Measured against the v11 pad's own
arithmetic (fee 1%, 80% of it to the coin's creator by default, 0.9375 zkLTC virtual
reserve): a trader washing their own coin pays 0.2% of volume and earns 9,950 points a
zkLTC lost; graduating one's own coin with one 3.03 zkLTC buy and selling into the pool
nets 2,191 points (2,000 of them `grad_creator`) for 0.58 zkLTC; today's first place,
19,687 points, is reached with 1.76 zkLTC net. A cap on daily volume does not touch the
creator route, which throwaway wallets repeat daily. Before a prize is paid on this board:
no trade points on a coin to its own creator or fee recipient, the creator's graduation
bonus proportional to distinct buyers' volume, an invitee's bonus after a minimum of
trades, and for the Sprint only coins created a day earlier by another wallet.

## Dependency policy (`web/`)

- `npm ci --ignore-scripts` everywhere: the lock is installed as it is and no
  dependency's lifecycle script runs (`web/.npmrc` enforces both for every
  npm command on the machine).
- Every direct dependency is pinned to an exact version; an update is a
  dedicated commit that names the versions and why.
- A release younger than seven days is not installed (`min-release-age=7`,
  read by npm 11 and later: the lock is installed with npm 11.21.1 in CI,
  on Netlify and by `packageManager`, and CI asserts the version and the
  setting before the install).
- `strict-peer-deps` stays off, the one exception to a strict install:
  WalletConnect's nested `valtio` declares a React 18 peer while the site
  runs React 19. Approved by the owner on 2026-10-19; reviewed on
  2027-01-19, or earlier when that peer declaration changes.
- `overrides` are used only to move a transitive dependency to a release that
  fixes an advisory, never to silence one: each is explained in this file.
- CI fails on any High or Critical advisory in the production dependencies
  and on an invalid registry signature.
