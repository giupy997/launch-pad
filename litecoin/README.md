# Notus on Litecoin

Litecoin has no smart contracts, so this launchpad is not a contract: it is
one ordinary Litecoin address (the **desk**) and a set of rules replayed over
the transactions that pay it, each carrying its instruction in an
**OP_RETURN**. Same chain, same rules, same answer — anyone can rebuild every
balance from a block explorer or their own node and check the state root.

Currently on the **Litecoin testnet** (testnet LTC has no value).

## How it works

| Piece | Where | What it does |
|---|---|---|
| The rules | `web/lib/litecoin/ledger.ts` | Pure, deterministic: ordered transactions in → coins, balances, fees, payouts and a state root out. The Litecoin counterpart of `Launchpad.sol`. |
| Transactions | `web/lib/litecoin/tx.ts` | Builds and signs the transactions (payments + OP_RETURN + change) with `@scure/btc-signer` and Litecoin's network parameters. Shared by the browser wallet and the desk. |
| Chain access | `web/lib/litecoin/esplora.ts` | Esplora / mempool.space API client (litecoinspace.org by default) and the mapping from an explorer transaction to a ledger event. |
| Indexer | `litecoin/indexer.ts` | Reads the desk's history, orders it by block and position, replays the rules, writes `web/public/litecoin/state.json`. |
| Spend path | `litecoin/payout.ts` | Pays what the ledger says is due (sell proceeds, claims), batched, each transaction carrying `NOTUS1 paid <ids>` — the payment itself marks them settled. Every transaction is recorded on disk (`sent-payouts.json`: ids, txid, signed hex, coins) before it is broadcast, rebroadcast while the network forgets it, fee-bumped when stuck, and given up only after several rounds — and then paid again with a transaction spending the same coins, so no payout can be paid twice. Only confirmed coins and the desk's own change are spent; with two explorers configured, a payout is made only when both confirm the sell behind it. |
| The desk | `litecoin/desk.ts` | Indexer + payouts + snapshot server in one long-running process, for a VPS (`litecoin/deploy/` has the systemd unit and Caddy config). |
| Website | `web/app/litecoin/*` | Explore, deploy, trade, wallet, ledger. Keeps a Litecoin wallet in the browser, builds every transaction there, signs it and broadcasts it through `/api/ltc` (a same-origin proxy to the explorer). |
| Test user | `litecoin/user.ts` | Does from a key file what the site does from the browser — for end-to-end tests. |

### Who owns what

Litecoin is transparent and every transaction is signed by whoever funds it,
so a balance belongs to a **Litecoin address**: the one that pays for the
transaction (its first input). No extra key, signature or nonce is needed —
the chain already authenticated the sender, and a transaction can only be
mined once. Sells and claims are paid back to that same address unless the
instruction points elsewhere.

Send from a wallet whose address you control. Never from an exchange: the
exchange's address would own the coins.

### Instructions (`NOTUS1 …` in the OP_RETURN, space separated, ≤ 80 bytes)

```
deploy TICKER name c|h [logo]     value ≥ deploy fee; the excess is a dev buy
logo   TICKER url                 creator only: set or change the logo
links  TICKER x=h tg=h web=site   creator only: X and Telegram handles, website (empty value clears)
buy    TICKER [minOut]            value = the LTC to spend
sell   TICKER amount minLit [o]   LTC paid to output o's address (default: the sender)
send   TICKER amount o            coins to the address of output o
claim  [o]                        creator fees + holder cashback + refunds
fund                              LTC for the desk's payout fees: treasury, owed to nobody
paid   id [id…]                   desk only: one output per payout, settles them
```

A payout's id is its position in the list up to block 3,191,000 on mainnet
(3,605,000 on testnet); from then on (`rulesV2From`) it is the first eight
hex digits of the transaction that created it (longer only on a collision),
so a reorg or an explorer that forgets a transaction cannot renumber what
the desk has already paid. From the same block a `sell`, `send` or `claim`
may only point at an address the network can pay (legacy, P2SH, segwit v0,
taproot); before it, any string an explorer produced passed.

An OP_RETURN holds 80 bytes and a bech32 address alone can take 62, so where
an instruction names another address it **points at one of its own outputs**
(`o` = output index) instead: the site adds a small output to the recipient
and writes its index. Names are URL-encoded (a space costs 3 bytes), so a long
name leaves no room for a logo in the deploy — that is what `logo` is for.

Curve and fees mirror the EVM launchpad: constant product with virtual
reserves (0.2 LTC on testnet, 10 LTC on mainnet: a curve raises ~32 LTC to
sell out; deploy costs 0.01 LTC), 1B supply with 800M on the
curve, 1% fee split 20% desk / 80% to the creator **or** the holders (fixed
at deploy; pro-rata accumulator, debts rounded up so claims never exceed the
pot). When the 800M are sold the coin **graduates** inside the ledger: the
LTC the curve raised and the 200M reserve become a locked constant-product
pool with real reserves (it opens a few percent under the curve's last
price, like a DEX listing would), and every later buy and sell trades
against that pool. There is no price ceiling — the pool's price is
LTC / tokens and a buy keeps pushing it up — and a sell always fills, since
the LTC is really there. On LitVM the pool is what migrates into Uniswap.

Nothing sent to the desk is lost: a buy that cannot fill (slippage, too
small, unknown ticker), a plain payment without a memo, a memo typed wrong — the LTC
is credited to the sender's address and can be claimed. The one exception is
deliberate: `fund` gives the desk LTC for its own network fees (the wallet
page has a "Fund the desk" box; a faucet payment without memo instead shows
up as owed to the faucet). Only a transaction
whose first input is not a standard single-address script has nobody to
credit; that LTC goes to the desk's fees.

Transactions fold into the ledger after 2 confirmations (~5 minutes; the
indexer's `NOTUS_LTC_CONFIRMATIONS`). Inside a block they are applied in
block order.

## The road to LitVM

LitVM is Litecoin's EVM layer 2 (Arbitrum Orbit, gas in zkLTC = bridged
LTC). Its Liteforge testnet is live (chain 4441); the mainnet is expected in
the second half of 2026. The Notus contracts run there unchanged, and every
coin on this ledger can move over with its holders and its price:

- **Same key, both chains.** Litecoin and EVM chains share secp256k1, and
  every holder who ever bought revealed their public key in their own
  transaction to the desk. The indexer records it (`pubkeys` in the
  snapshot), so each Litecoin address maps to an EVM address — the wallet
  page shows yours — and the migration mints straight to it. A holder whose
  key is not the one they can sign for on an EVM chain (a hardware wallet)
  registers another with `NOTUS1 evm 0x…` (rules v2), which the frozen
  ledger still takes; the writer prefers it. A holder who only ever
  *received* coins by `send` has no key on record: their balance is listed
  as unresolved and parked in a vault address for a signed claim.
- **Freeze.** `NOTUS_LTC_FREEZE=<height>` on the indexer, announced for a
  block still ahead of the chain (the indexer refuses one behind it, and one
  that changes): until then the site says when trading stops, past that
  block the ledger takes no deploy, buy, sell, send or logo (the LTC they
  carry is credited back); claims, payouts and `evm` keep working, so the
  desk settles what it owes on Litecoin. The frozen state root is what gets
  re-created, and the migration script commits it to the Launchpad
  (`setMigrationRoot`) before the first coin, so anyone can replay the
  ledger to that root and compare. The site shows the freeze on every
  Litecoin page and sends trading to LitVM: publish
  `web/public/litecoin/migrated.json` (the map the script writes next to
  the migration file) and each coin page links straight to its LitVM token.
- **The file.** `node litecoin/migration-snapshot.ts` turns the frozen
  snapshot — the freeze reached and six blocks deep, or it refuses — into
  `litecoin/migration/<network>-<height>.json`: per coin the
  curve (virtual and real reserve, sold — for a graduated coin the pool's
  LTC and `poolToken`, its token side, with `sold` everything the holders
  own), creator and holders as EVM addresses, balances — scaled from 8 to
  18 decimals — plus the LTC to bridge (the sum of the curves' and pools'
  real reserves) and what remains to settle on Litecoin.
- **The contracts.** `Launchpad.migrateToken` (owner only, one token per
  ticker, only while the migration is open) re-creates the coin with that
  state: `msg.value` is the bridged reserve — for a curve coin it must be
  what the curve implies, `virtual · sold / (1.05B − sold)`, or the call
  reverts — balances are delivered in batches (`migrateBalances`, each
  holder once: a batch sent twice reverts) and trading opens when every
  holder has theirs, at exactly the ledger's price. A coin that graduated
  on the ledger graduates again on delivery and its pool — the bridged LTC
  against `poolToken` tokens, so at the same price — goes into a locked
  Uniswap v2 pool (`UniV2Migrator`, LitVM has no v4). `closeMigration`
  ends it for good. The script is safe to rerun: it skips tokens that exist
  and holders already delivered.

```bash
NOTUS_LTC_FREEZE=<height> node litecoin/indexer.ts     # freeze, publish the frozen snapshot
node litecoin/payout.ts                                # settle what is due on Litecoin
node litecoin/migration-snapshot.ts [--vault 0x...]    # the migration file
# bridge the LTC it says to LitVM, then, from contracts/:
forge script script/DeployLitVM.s.sol --rpc-url litvm_testnet --private-key "$PRIVATE_KEY" --broadcast
LAUNCHPAD=0x... MIGRATION_FILE=../litecoin/migration/test-<height>.json \
  forge script script/MigrateFromLedger.s.sol --rpc-url litvm_testnet --private-key "$PRIVATE_KEY" --broadcast
cp litecoin/migration/test-<height>.json.migrated.json web/public/litecoin/migrated.json   # the site links each coin to its token
```

`forge test --match-contract Migration` runs the contract tests, including
the demo ledger's file end to end (`test/fixtures/migration-demo.json`).

## What is custodial

The desk holds the LTC in the curves — there is no escrow script on Litecoin
— and the ledger is the only record of balances. That is the trade-off of
the design, stated on the site's ledger page. The desk's address is public,
so its balance can be checked against what the ledger says is owed.

## Run it

```bash
cd web && npm ci --ignore-scripts && cd ..   # the scripts use web/'s dependencies; no install script runs next to a key
node litecoin/keygen.ts desk            # once: litecoin/desk/key.json (gitignored) — prints the desk address
# fund the desk with a little LTC for payout fees, then:
node litecoin/indexer.ts --watch        # keep the snapshot fresh (every 60s)
node litecoin/payout.ts                 # pay what is due (add --dry-run to only list)
node --test --experimental-strip-types web/lib/litecoin/*.test.ts litecoin/payout.test.ts   # ledger rules, solvency fuzz, transactions, the payout round
```

The key is read from `NOTUS_LTC_DESK_KEY` (the secret), `NOTUS_LTC_DESK_KEY_FILE`
(a key.json anywhere, how the systemd units get it) or `<desk dir>/key.json`.

### On a server (the way to run it for real)

One process does everything — `node litecoin/desk.ts`: an indexer pass every
minute, payouts every other pass, and the snapshot served on `:8787`
(`/state.json`, `/health`). Point the website at it and nothing depends on a
laptop or a commit any more.

```bash
# Ubuntu/Debian VPS, as a user "notus" (never root)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
git clone https://github.com/giupy997/launch-pad.git ~/launch-pad && cd ~/launch-pad
(cd web && npm ci --ignore-scripts)
node litecoin/keygen.ts desk          # prints the desk address; the key is in litecoin/desk/key.json
sudo mkdir -p /etc/notus && sudo mv litecoin/desk/key.json /etc/notus/desk-test.key   # out of the checkout
sudo chown root:root /etc/notus/desk-test.key && sudo chmod 0600 /etc/notus/desk-test.key
NOTUS_LTC_DESK=<the address> node litecoin/indexer.ts   # first full sync
sudo cp litecoin/deploy/notus-desk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now notus-desk
journalctl -u notus-desk -f           # watch it work
curl -s localhost:8787/health         # ok, snapshot age, payouts {live, stuck, dead, unpayable, solvent}
```

The unit writes the snapshot to `litecoin/cache/state.json` (gitignored) and
the record of sent payouts to `litecoin/desk/sent-payouts.json`, so updating
the server is always `git pull && sudo systemctl restart notus-desk`: the
stop waits for the pass in progress, and a payout round cut short anyway
only ever repeats the exact transaction it recorded. `/health` answers 503
when the snapshot is stale, a payout was given up or is unpayable, or the
desk's confirmed balance is under what the ledger owes — point an uptime
monitor at it.

### Mainnet

Same code, `NOTUS_LTC_NETWORK=main`, its own desk key and process next to
the testnet one. The parameters in `PARAMS.main` are part of the rules:
history is fixed once folded in, so a parameter only ever changes for coins
deployed from a future block on (`virtualLitChanges`: the first coins opened
with 10 LTC of virtual reserve, coins deployed from block 3,185,910 open with
30 LTC — a coin keeps the reserve it was born with). At that same block the
one-off `retireEmptyCoinsAt` rule retires the coins deployed before it that
nobody holds any more (the first coins, sold back to empty), freeing their
tickers for a redeploy under the new rules; cashback still owed on them stays
claimable. Every replayer runs the same code, so a rule change is the same
for everyone.

```bash
NOTUS_LTC_NETWORK=main node litecoin/keygen.ts desk-main   # litecoin/desk-main/key.json — back it up, this one holds real LTC
sudo mkdir -p /etc/notus && sudo mv litecoin/desk-main/key.json /etc/notus/desk-main.key
sudo chown root:root /etc/notus/desk-main.key && sudo chmod 0600 /etc/notus/desk-main.key
sudo cp litecoin/deploy/notus-desk-main.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now notus-desk-main
sudo cp litecoin/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy   # adds /main/state.json
```

litecoinspace.org's mainnet backend has had long outages (5xx and timeouts
for everyone, or over one address family only — the unit reaches it over
IPv6 first, `NODE_OPTIONS=--dns-result-order=ipv6first`). The unit therefore
lists a Blockbook explorer after it in `NOTUS_LTC_API`, and the site should
do the same in `LTC_API_UPSTREAM`, so neither the desk nor the wallets
depend on one service.

Fund the mainnet desk with a little LTC for payout fees (the `fund`
instruction, or a plain payment you then leave as the sender's credit). On
Netlify, the production site becomes the mainnet site with
`NEXT_PUBLIC_LTC_NETWORK=main` and
`LTC_STATE_URL=https://desk.notus-pad.fun/main/state.json`; a second Netlify
site from the same repository with the defaults and
`LTC_STATE_URL=https://desk.notus-pad.fun/state.json` keeps the testnet
reachable. Before opening it to the public: the desk custodies real LTC, the
software is unaudited, and a public launchpad may need a legal review (MiCA).

Put HTTPS in front with Caddy (`litecoin/deploy/Caddyfile`, a DNS record
such as `desk.notus-pad.fun` pointing at the server), then on Netlify set
`LTC_STATE_URL=https://desk.notus-pad.fun/state.json` and redeploy: the pages
read the live snapshot through `/api/ltc-state`, and the committed
`web/public/litecoin/state.json` only serves as a fallback. Fund the desk
address with a little LTC for payout fees; back the key file up; the
process exposes only the snapshot, never the key.

Needs Node ≥ 22.18 (runs the TypeScript directly). Environment variables:
`NOTUS_LTC_NETWORK` (`test`, default, or `main`), `NOTUS_LTC_API` (the
explorer: an Esplora endpoint, default `https://litecoinspace.org/testnet/api`,
or a Blockbook one ending in `/api/v2` — `https://litecoinblockexplorer.net/api/v2`
answers; Trezor's `ltc1.trezor.io` blocks server IPs; NowNodes wants
`NOTUS_LTC_API_KEY` — and several, comma separated, tried in
order when one times out or answers 5xx; one serving the other chain is
skipped), `NOTUS_LTC_DESK`
(the desk address, for verifiers without the key), `NOTUS_LTC_STATE`,
`NOTUS_LTC_CACHE`, `NOTUS_LTC_CONFIRMATIONS`; for the desk process also
`PORT`, `NOTUS_LTC_INDEX_EVERY`, `NOTUS_LTC_PAYOUT_EVERY`. For the website:
`LTC_STATE_URL` (the desk's snapshot URL), `NEXT_PUBLIC_LTC_NETWORK`,
`LTC_API_UPSTREAM` (what `/api/ltc` reads the chain through, same syntax as
`NOTUS_LTC_API`: Esplora, Blockbook or several in fallback — the proxy
speaks Esplora to the browser whatever answers it; `LTC_API_KEY` for a
Blockbook that wants one), `NEXT_PUBLIC_LTC_API` (to bypass the proxy),
`NEXT_PUBLIC_SOURCE_URL` (the public repository, e.g.
`https://github.com/giupy997/launch-pad`: with it the footer links the
source and the ledger pages print the rebuild commands; unset while the
repository is private, the site says the code is published at launch),
`PINATA_JWT` (optional). The deploy and coin pages offer a logo upload:
the image is squared and compressed in the browser and kept by the site —
on Netlify in the site's own blob store, served at `/i/<id>` (nothing to
set up) — or, with a Pinata key in `PINATA_JWT`, pinned to IPFS and carried
by the instruction as `ipfs://Qm…`. An OP_RETURN cannot hold the image
itself, only its short URL. Elsewhere, with neither, creators paste a URL.

To verify the published ledger you need no key at all:

```bash
NOTUS_LTC_DESK=<desk address> node litecoin/indexer.ts   # prints the state root
```

End-to-end on testnet:

```bash
node litecoin/keygen.ts user && node litecoin/user.ts whoami   # fund it from a faucet
node litecoin/user.ts deploy CAT "Lite Cat" h 0.01
node litecoin/user.ts buy CAT 0.05
node litecoin/user.ts sell CAT 50
node litecoin/user.ts claim
node litecoin/demo-state.ts             # synthetic snapshot to look at the UI with no chain activity
```
