# CLAUDE.md — working notes for Claude on this repository

Read this first. It says what the project is, how it is run and checked,
the conventions its owner holds to, and the mistakes not to repeat. The
long-form documents it points to (`README.md`, `MIGRATION.md`,
`SECURITY.md`, `POINTS.md`, `LAUNCH-BASE-V12.md`, `ops/README.md`,
`points/README.md`) are the source of truth on the details; keep them
current when the code changes.

## The owner and how to work with them

- One owner, one reviewer: giupy997. Every path is theirs (`CODEOWNERS`);
  nothing lands on `main` without their review.
- They write to you in Italian. Answer in Italian. Code, comments, commit
  messages and documentation stay in English.
- Do the whole task, then report. Do not ask permission for routine,
  reversible steps; do ask before anything that touches a live chain, a
  key, a deploy, or deletes data.
- When something is wrong with the request, say so in a line or two and
  still deliver under a stated assumption.
- `HANDOFF.md` is a private note for the owner: it is gitignored and must
  never be committed or quoted in a public place.

## What the project is

Notus (https://notus-pad.fun): a token launchpad on Base, quoted in cbLTC
(Litecoin wrapped by Coinbase). A bonding curve (constant product with
virtual reserves) that graduates into a locked Uniswap v2 pool, a 0.5%
launchpad fee to the treasury, and each coin's own tax (up to 10% a side)
split between its creator, its holders (cashback), a burn pot and a
liquidity pot. The same contracts run on LitVM's Liteforge testnet
(Litecoin's EVM L2) and have run on GIWA Sepolia and Robinhood Chain.

Live money is at stake: the Base v12 stack holds other people's funds.
Treat every change to `contracts/` as a change to a deployed financial
system.

## Layout

- `contracts/` — Solidity 0.8.24, Foundry (forge 1.8.3 in CI).
  - `src/LaunchpadBase.sol`, `src/Launchpad.sol`, `src/LaunchpadMigration.sol`:
    the pad, split under the EIP-170 size limit; the migration module runs
    by delegatecall from the pad's fallback.
  - `src/LaunchToken.sol`, `src/LaunchTokenFactory.sol`: the ERC-20 and
    its factory; transfers locked until graduation, taxed on pool trades after.
  - `src/UniV2Migrator.sol`: graduation adapter for Uniswap v2 chains (Base,
    LitVM) and the `harvest` that sells the tax buckets a slice a block.
  - `src/SlipstreamZapRouter.sol`, `src/ZapRouter.sol`: one-transaction ETH
    buys on cbLTC-quoted curves.
  - `script/`: deploy scripts (`DeployBase.s.sol`, `DeployLitVM.s.sol`,
    `DeployTimelock.s.sol`), the ledger migration (`MigrateFromLedger.s.sol`,
    `snapshot-evm.mjs`, `merkle.mjs`), rehearsals (`rehearse-*.sh`,
    `try-v12-liteforge.sh`), the owner's operations (`script/ops/`:
    `timelock.sh`, `migrator.sh`, `harvest.sh`), `pool-probe.mjs`.
  - `test/`: unit tests plus fork tests (`*.fork.t.sol`, need a node, not
    run in CI). `legacy/` holds parked adapters and tests.
  - `verify/`: the Standard JSON inputs of each deployed stack, as the
    explorers accepted them. Never regenerate a deployed stack's input
    from a different forge version.
  - `lib/`: git submodules (openzeppelin-contracts, forge-std, v4-core).
    Clone with `--recursive`.
- `web/` — Next.js 16 (App Router, `--webpack`), React 19, TypeScript,
  Tailwind 3, wagmi 2 + viem 2, TanStack Query. Deployed on Netlify
  (`netlify.toml` at the root, base `web`). Pages in `app/`, UI in
  `components/`, chain reads and helpers in `lib/`.
- `points/` — the points service (`service.ts`), its systemd unit and
  Caddyfile under `deploy/`. See `POINTS.md`.
- `ops/` — the owner's watch (`watch.mjs`: timelocks, pads, site → Telegram)
  and its systemd unit.
- `parked/` — Notus on Litecoin (OP_RETURN ledger) and on Zcash testnet:
  kept for the record, not built, run or served. Do not revive or modify
  unless asked.

## Commands

Contracts (from `contracts/`):

```
forge fmt --check
forge test --no-match-path "test/*.fork.t.sol"      # what CI runs
RUN_FORK_LIVE=true forge test --match-contract LiveBase -vv   # fork tests, need a node
```

Site (from `web/`, Node 22, see `.nvmrc`):

```
npm ci --ignore-scripts
npx tsc --noEmit
npx eslint . --max-warnings 0
node --test --experimental-strip-types lib/points/*.test.ts lib/trades/*.test.ts lib/sanitize.test.ts lib/imageType.test.ts
npm run build
npm run dev                                          # http://localhost:3000
```

Run the relevant set before every push. CI (`.github/workflows/ci.yml`)
runs exactly these; a push that turns it red costs a review cycle.

Deploys and owner operations sign with a Foundry keystore (`--account
notus`), never a private key on the command line or in a file. Never run
a deploy, a `cast send`, or a timelock operation on your own initiative.

## Conventions

### Commits

- Subject: lowercase area prefix, colon, then a plain sentence saying what
  changed, as a fact: `contracts: the harvest is a slice a block on any day`,
  `web: the token-to-token swap page goes`, `ops: timelock.sh runs each
  saved operation on its own timelock`, `docs: …`. Earlier history also
  uses `Site:`; prefer the lowercase form.
- Body: prose paragraphs that explain why, name the files and functions,
  and cite the security finding (`SECURITY.md`, e.g. H-02) or document
  the change answers. No bullet lists in commit bodies.
- One commit per coherent change. Documentation is updated in the same
  commit as the code it describes.

### Writing style (docs, comments, commit bodies)

The owner writes in a particular voice and expects it kept: declarative
sentences stating what the code does and why, concrete figures (blocks,
amounts, addresses with `0x1234…abcd` ellipsis), no marketing language, no
hedging. Comments describe the behaviour and the reason, not the mechanics
the code already shows. NatSpec (`/// @title`, `/// @notice`) on contracts
and public functions.

### Solidity

- `forge fmt` is the formatter; the vendored `lib/` is excluded.
- Named imports (`import {IERC20} from …`). OpenZeppelin via the
  `openzeppelin-contracts/` remapping.
- Custom errors and events live in `LaunchpadBase.sol`.
- Every behaviour change gets a test in `contracts/test/`; fee and
  solvency changes get a fuzz or invariant test. Throwaway tests from
  review go in `contracts/test/_review_*` (gitignored).
- The pad is at the EIP-170 size limit: new owner-only or migration
  functions go in `LaunchpadMigration.sol`, not `Launchpad.sol`.
- Uniswap v2 swaps against a taxed coin must use the
  `...SupportingFeeOnTransferTokens` router variants; exact-output swaps
  are not supported.

### TypeScript / site

- Exact dependency versions, lockfile is the law, `npm ci --ignore-scripts`
  always (`web/.npmrc`). Adding or bumping a dependency is a reviewed,
  deliberate act: pin it exactly and run `npm audit`.
- Creator-supplied metadata is untrusted: URLs go through `lib/sanitize.ts`
  (`safeLink`, `safeLogo`), images through the site's proxy.
- Chain reads happen on the app's chain; never guess a fee, read it.
- Tests are `node --test` files next to the code (`*.test.ts`).
- `web/README.md` is still the create-next-app template; the real
  documentation is the root `README.md`.

## Security posture (do not weaken)

- Every pad's owner is a `TimelockController` (24 h on Base, 48 h default
  for LitVM mainnet). From 2026-10-13 the Base proposer is a Safe 2-of-3;
  the deployer key alone can schedule nothing.
- Deploy scripts read the proposer from the broadcast's signer and refuse
  forge's stand-in sender (a stack was lost to that once: the first v12
  stack has a timelock nobody can drive).
- Never print a keyed RPC URL: logs and errors show the node's host only.
- Never commit `.env`, keystores, `HANDOFF.md`, `ops/state/`, desk or
  user key directories.
- GitHub Actions are pinned to commits; the token is read-only.
- Reports in `SECURITY.md` have IDs (H-01, H-02, M-01, L-01…): reference
  them when a change answers one, and update their status there.

## Lessons already paid for

- Base v9 was drained at graduation: a buyer starved the automatic
  migration of gas, pre-seeded the pool low, and the v1 migrator traded
  the reserve into it. Fixes since: graduation migrates atomically, the
  migrator never trades against a pre-seeded pool. Keep both.
- An uncapped harvest after a freeze announcement could be sandwiched;
  the harvest is now a slice a block, always. Do not add a "sell it all"
  mode.
- A harvest that decided its liquidity leg on an estimate reverted on a
  few satoshis of tax; decide on exact amounts.
- Multiple hostnames serving the same pages got the site flagged by Safe
  Browsing: retired domains answer 404 with a plain page, never redirect.
- Fork-test actors live at keyless addresses so no EIP-7702 sweeper eats
  the ETH they receive.
- Events in the points service are counted once however often they are
  read; keep every scan idempotent.

## When the owner asks for a review or an audit

Read the deployed addresses and versions in `README.md` (Deployments)
before judging the code: the repository's `UniV2Migrator.sol` is ahead of
the v3 deployed on Base. Say which version a finding applies to. Put
findings in `SECURITY.md` with an ID and a status, not only in chat.
