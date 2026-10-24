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
| 2026-10-12 | a LitVM community member (technical security assessment of commit `27959e9`: contracts, migration, site, points, operations, npm supply chain) | 4 High, 4 Medium, 3 Low, no Critical | see below |
| 2026-10-19 | the same reviewer: a re-check of the remediation (the named commits, `main`, CI, the live site, the Base deployment with migrator v5) | H-02, M-02, M-03 and H-03's production exposure closed; H-01 and L-01 verified in code, to be confirmed on the deployed LitVM pad; M-01 and H-04 kept open; eight points of hygiene (the dev-tooling advisories, `npx` in CI, branch protection, dependency review, secret scanning, static analysis, the wallet-bundle wording, two stale live-fork tests, host-level verification of the units) | answered the same day, finding by finding below: M-01 open for the next pad; the repository settings enabled by the owner the same evening (a ruleset on `main` against deletion and force pushes, secret scanning with push protection, Dependabot and malware alerts, private vulnerability reporting); the units' exposure measured on the server (L-02); the live-fork tests run from the server against the v12 stack, 21 of 21 passed |

### The 2026-10-12 assessment, finding by finding

| ID | Finding | Status |
|---|---|---|
| H-01 | The migration root is informational: the operator chooses holders and balances with no proof against it | Fixed in code 2026-10-12: the root is the Merkle tree of the snapshot (a leaf per coin as recorded, a leaf per holder's balance; OpenZeppelin's standard leaves), committed once through the timelock; `migrateToken` and `migrateBalances` verify every coin and every balance against it, so the operator delivers what the snapshot says and nothing else; the snapshot tool (`script/merkle.mjs`) and the migration script (`script/MerkleTree.sol`) build the same tree, cross-checked by the fixture test, and anyone can rerun the tool on the frozen source and compare the root. Lands with the next pad (the LitVM mainnet pad, deployed from this code); Base v12 keeps its module, which only matters for a migration *into* Base, none planned. To be confirmed on the deployed LitVM pad at its deploy (the reviewer's re-check of 2026-10-19): the root set through the timelock, a delivery verified against it |
| H-02 | Once a freeze is announced, `harvest` sells a coin's whole tax bucket in one call, with no cap and no minimum | Fixed in code 2026-10-12: the rush mode is gone; a harvest is a capped slice (a 0.5% move of the pool, which a trade wrapped around one slice cannot profit from) on any day, a freeze announced included, and the notice (a day at least) is time enough for the keeper (`contracts/script/ops/harvest.sh`, named in `MIGRATION.md`) to empty any bucket; tests cover a sandwich under an announced freeze and the keeper's loop. On Base this is `UniV2Migrator` v4 (`0xaB95…fEf1`), deployed on 2026-10-12 from this code and verified on Basescan; the Safe scheduled `setMigrator` the same night (two signatures) and it executed on 2026-10-14 at block 52,573,727, before any coin graduated on v12 (a coin keeps the migrator it graduated through). The internal review of 2026-10-13 found that v4's pacing (a slice a block) still let a run of slices be fronted: the price moved once, every later slice sold into it; v5 paces harvest and buyback five minutes apart per coin, so the move has to be held in the open for minutes a slice; deployed on Base on 2026-10-14 (`0x6007…3434`, block 52,573,869, from this code, verified on Basescan) and set on the pad by the Safe the same way (scheduled on 2026-10-14 with two signatures, executed on 2026-10-15 at block 52,618,587), before the first graduation; the LitVM pad deploys with it |
| H-03 | Known High npm advisories in the site's dependencies | Fixed 2026-10-12: Next.js 16.3.8 (the image-optimization SSRF, GHSA-cjq9-62q9-8jv4), nanoid and source-map-js updated, axios and ws pinned to their fixed releases through `overrides` (axios sits in Coinbase's wallet SDK, which the site never instantiates; `ws` in WalletConnect's nested viem, a Node-only module that is never in the browser bundle, while the WalletConnect connector itself is instantiated when `NEXT_PUBLIC_WC_PROJECT_ID` is set, as it is on the site: the wording the reviewer's re-check of 2026-10-19 corrected). `npm audit --omit=dev` reports no High or Critical advisory; the remaining Moderate ones are in the same connector graph and in development tooling, and CI fails on any new High in production dependencies. Development tooling, re-checked on 2026-10-19: the eight High advisories there are one chain, `braces` and `micromatch` (stack exhaustion on deeply nested glob patterns), reached through `eslint-config-next` and Tailwind 3; no fixed release of `braces` exists and the fix npm names is Tailwind 4, a migration of its own. They run in lint and build only, on patterns this repository writes, never on the site: accepted on 2026-10-19, reviewed with every dependency update and on 2027-01-19 at the latest. `brace-expansion` 1.1.16 under eslint's `minimatch` 3 (an unbounded expansion; the one of the eight with a fixed release in its line) is moved to 1.1.21 by an override. 2026-10-22: three advisories on Next.js 16.0.0 to 16.4.0 (GHSA-2464-fhr4-w9xw, an unauthenticated remote code execution in the image-optimization API with SVG files; GHSA-673q-mjm6-r5xr, the same through `use cache` functions returning typed arrays; GHSA-p3m5-59mp-jv5r, a denial of service in server actions) and two on `follow-redirects` 1.16.0 (GHSA-q3jh-wrc6-jgq8, GHSA-8r9p-f939-6h3c, credential headers kept across origins; under Coinbase's SDK in the wallet connectors). The site uses neither `use cache` nor server actions and does not allow SVG through `next/image`; patched the same day all the same: Next.js 16.4.2 (published 2026-10-15, seven days old that evening, as the hold wants) with `eslint-config-next` 16.4.2, and `follow-redirects` moved to 1.16.1 by an override. The production audit is clean again; the seven High in development tooling are the accepted ones above. 2026-10-24: GHSA-mrhx-c7xc-m3w5 on `zod` below 4.6.6 (memory exhaustion while validating oversized constrained collections; published 2026-10-01, in npm's database from 2026-10-24, where it turned CI red on `b978b98`). `zod` sat in three places in the production graph: Reown's `appkit-wallet` (the WalletConnect modal's embedded-wallet frame, which pins 3.22.4 upstream still), `@wagmi/connectors` (3.25.76, which its code never imports) and `h3` with `zod-validation-error` (4.4.3); none of them validates anything a stranger sends the site. Moved to 4.6.7 (published 2026-10-12) everywhere by an override the same day: `appkit-wallet`'s schemas construct under zod 4 (its module loaded in Node to check), the gate and the production audit are clean |
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
| I-02 | For the next pad: the curve-side slice of `buybackAndBurn` (half a percent of the virtual reserve, a block) is safe against a wrapped trade because every coin pays the launchpad's fee both ways, 0.5% a side on v12, stamped at launch. A pad whose `feeBps` is lowered under 25 would let a coin taxed less than the difference be bought and sold around its own buyback at a profit, a block at a time, until the pot is gone | Noted for the next pad: size the curve slice from the coin's stamped rate (`platformBps` + the lower of its taxes), as the pool's slice is sized by Uniswap's fee |

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
