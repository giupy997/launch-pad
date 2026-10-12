# Security

## Reporting a vulnerability

Please report privately, never in a public issue:

- GitHub's private vulnerability reporting on this repository (Security →
  Report a vulnerability), or
- email to the maintainer: giupy997@gmail.com.

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
  day later; anyone may execute a ready operation. From 2026-10-13 the only
  proposer and canceller is a Safe 2-of-3 (`0x934A…d8F4`); the deployer's key
  alone can no longer schedule or cancel anything.
- The retired v11 pad on Base keeps its settings for good: its timelock has
  no proposer from 2026-10-13 on.
- A read-only watch (`ops/watch.mjs`) reports on Telegram every operation
  scheduled, executed or cancelled, every role change, every owner-only event
  on the pads, and every deploy of the site, within a minute.
- The deployer's key lives in a Foundry keystore on one machine with
  key-only SSH; it signs rehearsals, the daily operations of the Liteforge
  rehearsal pad, and the execution of ready timelock operations.

## Independent reviews

No formal audit has been commissioned. Two independent security reviews were
received; both are answered in full in the repository's history.

| Date | Reviewer | Findings | Status |
|---|---|---|---|
| 2026-10-09 | zauth (external report on the contracts, the site and the parked Zcash code) | 4 Medium, 1 High (a Zcash viewing key handled in the parked code) | Mediums fixed in `5ee0e68`; the High closed on 2026-10-10 by parking the Zcash and Litecoin code out of every build (`51235fb`) |
| 2026-10-12 | a LitVM community member (technical security assessment of commit `27959e9`: contracts, migration, site, points, operations, npm supply chain) | 4 High, 4 Medium, 3 Low, no Critical | see below |

### The 2026-10-12 assessment, finding by finding

| ID | Finding | Status |
|---|---|---|
| H-01 | The migration root is informational: the operator chooses holders and balances with no proof against it | Open, scheduled before the Base → LitVM migration: per-holder Merkle proofs against the root the timelock commits to, coin totals bound the same way. Until then no migration is planned, and the operator role is granted only through the timelock, a day ahead, in the open |
| H-02 | Once a freeze is announced, `harvest` sells a coin's whole tax bucket in one call, with no cap and no minimum | Open, scheduled with H-01 for the next migrator: in that window only the one-block cooldown goes, the per-call cap (a 0.5% move of the pool) stays; a keeper empties the buckets over the window. On Base v12 the coins already graduated keep the migrator that graduated them: on migration day the runbook empties their buckets before the announcement, and the loss a sandwich could cause is bounded to the fees accrued during the window |
| H-03 | Known High npm advisories in the site's dependencies | Fixed 2026-10-12: Next.js 16.3.8 (the image-optimization SSRF, GHSA-cjq9-62q9-8jv4), nanoid and source-map-js updated, axios and ws pinned to their fixed releases through `overrides` (both sit in wallet connectors the site never instantiates: Coinbase's SDK and WalletConnect's nested viem; neither runs in the browser bundle). `npm audit --omit=dev` reports no High or Critical advisory; the remaining Moderate ones are in the same unused connector graph and in development tooling, and CI fails on any new High in production dependencies |
| H-04 | No npm policy in the repository: loose ranges, no `.npmrc`, no immutable install in the deployment notes | Fixed 2026-10-12: `web/.npmrc` (no lifecycle script ever runs, exact versions saved, `min-release-age=7` for npm 11 and later), every direct dependency pinned exactly, `packageManager` pinned, every install in the docs and on the servers is `npm ci --ignore-scripts`. `strict-peer-deps` is not set: WalletConnect's nested `valtio` declares a React 18 peer, which fails the immutable install under that flag; the build and the site run on React 19 regardless |
| M-01 | The LitVM deploy script leaves the pad under the deployer's key until a later script hands it to a timelock | Open, by design for the Liteforge rehearsal pad (faucet money, redeployed often). The LitVM mainnet pad will be deployed as Base's was (`script/DeployBase.s.sol`): the timelock owns it from its first block, a multisig proposes |
| M-02 | The points indexer appends events before it writes its checkpoint: a crash in between replays them | Fixed 2026-10-12: every event is counted once by transaction and log index, however often it is read or written; a crash-replay test covers it |
| M-03 | A two-step token-to-token swap page could spend the wallet's own native balance beyond the sale's proceeds | Fixed 2026-10-12 by removing the page: it was never linked from the site and listed only native-quoted curves, so it showed nothing on Base (cbLTC-quoted) and worked only on the Liteforge rehearsal pad |
| M-04 | No CI, no protected-file rules, `forge fmt --check` failing | Fixed 2026-10-12: `.github/workflows/ci.yml` (actions pinned to commits, read-only token, immutable install with no lifecycle script, registry signatures, production-dependency audit, types, lint, unit tests, build; forge fmt and the contract tests), `CODEOWNERS`, this file, the contracts formatted. Branch protection on `main` is a repository setting the owner enables |
| L-01 | The ERC-20 buy credits the amount requested, not the amount received | Open, scheduled for the next pad: a balance-delta check that reverts unless they match. On Base v12 the only quote asset is cbLTC, a standard token, and a quote asset can only be added through the timelock |
| L-02 | The systemd units carry no sandboxing directives | Open, scheduled: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` with the state directories writable, `PrivateTmp`, a restrictive `UMask` |
| L-03 | The site's Content Security Policy allows inline scripts | Open: a nonce-based policy needs a request-time nonce through Next.js middleware; planned, low priority, no HTML sink exists in the application |

## Dependency policy (`web/`)

- `npm ci --ignore-scripts` everywhere: the lock is installed as it is and no
  dependency's lifecycle script runs (`web/.npmrc` enforces both for every
  npm command on the machine).
- Every direct dependency is pinned to an exact version; an update is a
  dedicated commit that names the versions and why.
- A release younger than seven days is not installed (`min-release-age=7`,
  enforced by npm 11 and later; checked by hand before that).
- `overrides` are used only to move a transitive dependency to a release that
  fixes an advisory, never to silence one: each is explained in this file.
- CI fails on any High or Critical advisory in the production dependencies
  and on an invalid registry signature.
