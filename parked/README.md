# Parked: Notus on Litecoin (the ledger) and Notus on Zcash

Two launchpads with no contracts lived next to the EVM pads: **Notus on
Litecoin**, an OP_RETURN ledger (one desk address, instructions in the
transactions that pay it, balances anyone recomputes from the chain), and
**Notus on Zcash**, a testnet ledger replayed from the encrypted memos sent to
one shielded address. Both are parked here: kept for the record, not served by
the site, not built, not run.

## Why

The site exposes the EVM launchpads alone: Base, quoted in cbLTC, and LitVM
(the Liteforge testnet today, LitVM mainnet when it is live). The two ledgers
had closed or never left the testnet, yet their pages, API routes and static
snapshots were still served, and an external white-box review (2026-10-09)
rated a finding in them **high**: the Zcash desk's viewing key, published in
the snapshot the site served at `/zcash/state.json` (below). Parking takes both
sections off the site, out of its build and off the server, so what an
auditor reads is what the site runs.

## Nothing was deleted

Every parked file was moved with `git mv` to the same path under `parked/`:
`web/app/zcash/` is now `parked/web/app/zcash/`, `litecoin/desk.ts` is
`parked/litecoin/desk.ts`, and so on. `git log --follow parked/<path>` shows
a file's whole history.

| Parked | What it was |
|---|---|
| `web/app/litecoin/`, `web/app/zcash/` | the two sections' pages (explore, deploy, coin, wallet, ledger, fund) |
| `web/app/api/ltc/`, `web/app/api/ltc-logo/` (with `gc/`), `web/app/api/ltc-state/` | the Litecoin explorer proxy, the logo upload and its garbage collector, the desk snapshot proxy |
| `web/components/litecoin/`, `web/components/zcash/` | their components, the header's wallet chips among them |
| `web/lib/litecoin/`, `web/lib/zcash/` | the ledger rules, transaction builder, explorer clients, browser wallets, with their tests |
| `web/public/litecoin/state.json`, `web/public/zcash/state.json` | the static snapshots the pages fell back on |
| `web/public/chains/zcash.svg` | Zcash's logo in the chain switcher |
| `web/netlify/edge-functions/upload-limit.ts` | the rate limit of the logo upload |
| `litecoin/` | the desk (indexer, payouts, cold-storage sweep, keys), its systemd units, the ledger's own migration runbook and snapshot tool, its README |
| `zcash/` | the Zcash indexer, payout and test-user tools, its README |

`parked/` sits outside `web/`: Netlify builds `web/` alone, and
`web/tsconfig.json` and ESLint see nothing outside it. Nothing under `web/`
imports from `parked/`, and `web/next.config.mjs` sends every old link into
either section (`/litecoin/…`, `/zcash/…`, their snapshots too) to the home
page with a temporary redirect, the old fund page to `/bridge`.

## What stayed live

A few pieces the EVM site shares with the sections stayed, moved to neutral
homes:

| Now | Was | Why it stays |
|---|---|---|
| `web/lib/safeFetch.ts` | `web/lib/litecoin/safeFetch.ts` | `/api/img`, the logo proxy every coin card goes through |
| `web/lib/imageType.ts` (+ test) | `imageTypeOf` in `web/lib/litecoin/pin.ts` | the same proxy judges an image by its bytes; the rest of `pin.ts` is parked and imports it back |
| `web/lib/logoStore.ts` | `web/lib/litecoin/logoStore.ts` | `/i/<id>` serves the logos the site stored, which coins migrated onto the pads still name; the Netlify Blobs store keeps its name, `ltc-logos` (renamed, it would lose them) |
| `SITE_URL` in `web/lib/site.ts` | `web/lib/litecoin/server.ts` | the sitemap, `robots.txt` and the link preview; the rest of `server.ts` is parked |
| `points/deploy/Caddyfile` | `litecoin/deploy/Caddyfile` | the VPS's only Caddy config: its `/points/*` block fronts the points service; the desk's two blocks are commented out in it |

`/api/ltc-price` (the LTC price behind every USD figure of cbLTC and zkLTC),
`web/lib/price.ts`, `/api/img`, `/i/<id>` and `web/public/chains/litecoin.svg`
(cbLTC's logo) never belonged to the sections and stay as they are.
`litecoin/migration/` stays at the repository's root: it is the EVM
migration's working directory (`MIGRATION.md`, the rehearsal scripts and
`contracts/foundry.toml`'s `fs_permissions` name it), not part of the ledger.

## The Zcash viewing key

Until this change `web/public/zcash/state.json` carried the Zcash desk's
Unified Full Viewing Key (`desk.ufvk`), written by `zcash/indexer.ts` and
served to anyone at `https://notus-pad.fun/zcash/state.json`. A viewing key
cannot spend, but it decrypts every memo and every amount the desk ever
received. Now:

- the parked snapshot no longer has the field, and neither the indexer nor
  `zcash/demo-state.ts` writes it; the pages and the snapshot's type no
  longer show or carry it;
- the key itself is still in this repository's history, in every commit
  that carried the snapshot: **treat it as public**. The desk was a testnet
  wallet (TAZ has no value) and the section is parked, so nothing of value
  hangs on it.

If the Zcash section ever comes back, give it a new desk wallet (a new seed:
a new address and a new viewing key) rather than the old one, and hand the
viewing key to whoever audits the ledger instead of publishing it.

## The Litecoin ledger's last balances

When the sections were parked, the mainnet desk could still owe what its
snapshot (`desk.notus-pad.fun/main/state.json`) lists: the `claimable` map
(creator fees, holder cashback, refunds, carried dust, per address) and any
payout not yet paid. Parking closes the two ways to collect them, one after
the other:

- **The site side closes with the deploy**, not with anything done on the
  server. A claim is an OP_RETURN memo the holder sends from
  `/litecoin/wallet`, and a wallet made in the browser keeps its key in that
  browser's storage, where only that page reads it. Netlify deploys `main`
  on push, and from that deploy on every `/litecoin/…` link goes home. So
  before the push that parks the site, whoever has a claim to send or LTC in
  a browser wallet claims, withdraws, or reveals and keeps the wallet's key
  (the wallet page does all three), or the owner decides to leave it.
- **The desk side closes with the pull on the server.** The desk pays the
  claims that were sent, and the cold-storage sweep moves the treasury, only
  while `litecoin/desk.ts` and `litecoin/sweep.ts` are where the units and
  the commands name them. Let the desk pay every claim and see the payments
  confirmed, stop it, sweep, then pull.

What nobody claimed stays on the desk address, still owed in the ledger; the
desk's key is what reaches it, so the key is kept. After the pull the desk
tools still run, in place (next section).

## Running parked code

The parked files keep the imports they had under `web/`, rewritten only
where a shared module moved (`@/lib/safeFetch`, `@/lib/logoStore`,
`SITE_URL` from `@/lib/site`, `../imageType.ts`). So the pages, routes
and components resolve again once moved back, and not before: the `@/`
alias, `../site.ts` and `../imageType.ts` point into `web/`, and the
packages they use (`@scure/btc-signer`, `@scure/base`, `@noble/curves`,
`@noble/hashes`, `qrcode`) come from `web/node_modules`. The desk tools import
`../web/lib/litecoin/*.ts` and `../web/lib/zcash/ledger.ts`, which the move
kept side by side.

The desk tools (`parked/litecoin/*.ts`) and the ledger code they import run
where they are, from the repository's root, once `parked/web/node_modules`
links to the site's packages (ignored by git, like every `node_modules`):

```bash
(cd web && npm install --no-audit --no-fund)
ln -s ../../web/node_modules parked/web/node_modules
node --test --experimental-strip-types parked/litecoin/*.test.ts parked/web/lib/zcash/*.test.ts \
  parked/web/lib/litecoin/{chain,esplora,ledger,message,tx}.test.ts
```

So does the sweep, with the desk's environment as its unit sets it
(`NOTUS_LTC_NETWORK`, `NOTUS_LTC_DESK_DIR`, `NOTUS_LTC_STATE`, the key file):
`node parked/litecoin/sweep.ts --to <cold address> --reserve 0.05`, then the
same with `--yes`. `NOTUS_LTC_STATE` must name the desk's own snapshot:
without it the tools read `parked/web/public/litecoin/state.json`, a testnet
demo. `lib/litecoin/client`, `volume`, `logoGc` and `pin` tests need the
move back: they import through the `@/` alias, `../site.ts` or
`../imageType.ts`, which point into `web/`.

Every test, run in place after a move back (from `web/`):

```bash
node --test --experimental-strip-types lib/litecoin/*.test.ts lib/zcash/*.test.ts
node --test --experimental-strip-types ../litecoin/payout.test.ts ../litecoin/sweep.test.ts
```

`lib/litecoin/client.test.ts` and `volume.test.ts` failed before the
sections were parked: `client.ts` imports `@/lib/price`, an alias Node does
not resolve.

## Bringing a section back

1. Move its files back, for example the Zcash section:

   ```bash
   git mv parked/web/app/zcash web/app/zcash
   git mv parked/web/components/zcash web/components/zcash
   git mv parked/web/lib/zcash web/lib/zcash
   git mv parked/web/public/zcash web/public/zcash
   git mv parked/web/public/chains/zcash.svg web/public/chains/zcash.svg
   git mv parked/zcash zcash
   ```

   and for the Litecoin ledger `parked/web/app/litecoin`,
   `parked/web/app/api/{ltc,ltc-logo,ltc-state}`,
   `parked/web/components/litecoin`, `parked/web/lib/litecoin`,
   `parked/web/public/litecoin`,
   `parked/web/netlify/edge-functions/upload-limit.ts` and every file of
   `parked/litecoin/` to their old paths.
2. Wire it into the site again; the commit that parked the sections (the one
   that added this file) shows every line that was taken out:
   - `web/next.config.mjs`: drop the section's redirects (`/zcash/:path*`, or
     `/litecoin/:path*` and `/litecoin/fund`), or keep the ones for pages
     that stay closed;
   - `web/components/HeaderWallet.tsx`: on the section's paths the header
     shows its wallet instead of the EVM connect button (`HolderChip` from
     `components/zcash/HolderKey`, `LtcWalletChip` from
     `components/litecoin/Wallet`);
   - `web/components/Nav.tsx` and `BottomNav.tsx`: the section's own menu
     (explore, deploy, wallet, ledger) on its paths;
   - `web/components/ChainSwitcher.tsx`: the section as a network (an entry
     with its path and a logo id, `-1` for Zcash, `-2` for Litecoin);
   - `web/netlify/edge-functions/rate-limits.ts`: `/api/ltc-logo` and
     `/api/ltc/*` back next to `/api/img`;
   - `web/app/sitemap.ts`, if the section's pages should be indexed.
3. Set its environment (below) and, for the Litecoin desk, uncomment its
   blocks in `points/deploy/Caddyfile`, install its units again
   (`litecoin/deploy/`) and restore the logo collector's cron.

## Dependencies only parked code uses

`@scure/btc-signer`, `@scure/base`, `@noble/curves`, `@noble/hashes`,
`qrcode` and `@types/qrcode`. They stay in `web/package.json` (the desk tools
resolve them from `web/node_modules`); nothing the site builds imports them
now.

## What served them

**Netlify** (the site's environment), read only by parked code:
`LTC_STATE_URL` (the desk's snapshot, for `/api/ltc-state`, the coin pages
and the logo collector), `NEXT_PUBLIC_LTC_NETWORK`, `NEXT_PUBLIC_LTC_API`,
`LTC_API_UPSTREAM`, `LTC_API_KEY` (the explorer proxy and the logo upload),
`PINATA_JWT` (logos pinned to IPFS) and `LOGO_GC_SECRET` (the collector).
`NEXT_PUBLIC_SITE_URL` and `POINTS_URL` are the EVM site's and stay.

**The VPS**:

- `notus-desk` (testnet, port 8787) and `notus-desk-main` (mainnet, port
  8788), both `node litecoin/desk.ts` from the checkout
  (`parked/litecoin/deploy/`), with their keys outside it through systemd's
  `LoadCredential` and their data in the checkout's untracked
  `litecoin/cache/` and `litecoin/desk*/` (still ignored by git, so a pull
  leaves them alone); environment `NOTUS_LTC_*` (network, desk directory,
  state file, key file, explorer API and its key, confirmations, payout
  limits, freeze). The units name `litecoin/desk.ts`, which a checkout
  pulled past the parking no longer has: they are stopped and disabled
  before the pull, after the last payouts and the sweep (see *The Litecoin
  ledger's last balances*);
- Caddy's desk blocks (`/state.json`, `/health`, `/main/*` on the desk's
  hostname), now commented out in `points/deploy/Caddyfile`;
- a daily cron that called `POST /api/ltc-logo/gc` with `LOGO_GC_SECRET`.

The Zcash tools never ran on the server (`NOTUS_ZCASH_*`: wallet directory,
state file, network, test user).

A Litecoin browser wallet made on the site keeps its key in that browser's
storage for the site's origin (`notus.litecoin.key…`), as a Zcash holder key
does (`notus.zcash.holder`): moving the wallet page back lets its owner reach
it again.
