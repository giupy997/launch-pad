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
| Spend path | `litecoin/payout.ts` | Pays what the ledger says is due (sell proceeds, claims), batched, each transaction carrying `NOTUS1 paid <ids>` — the payment itself marks them settled. |
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
buy    TICKER [minOut]            value = the LTC to spend
sell   TICKER amount minLit [o]   LTC paid to output o's address (default: the sender)
send   TICKER amount o            coins to the address of output o
claim  [o]                        creator fees + holder cashback + refunds
paid   id [id…]                   desk only: one output per payout, settles them
```

An OP_RETURN holds 80 bytes and a bech32 address alone can take 62, so where
an instruction names another address it **points at one of its own outputs**
(`o` = output index) instead: the site adds a small output to the recipient
and writes its index. Names are URL-encoded (a space costs 3 bytes), so a long
name leaves no room for a logo in the deploy — that is what `logo` is for.

Curve and fees mirror the EVM launchpad: constant product with virtual
reserves (0.2 LTC on testnet, 20 LTC on mainnet), 1B supply with 800M on the
curve, 1% fee split 20% desk / 80% to the creator **or** the holders (fixed
at deploy; pro-rata accumulator, debts rounded up so claims never exceed the
pot). There is no DEX to graduate to: the curve stays the market, a sell
always fills, and the last 200M stay reserved.

Nothing sent to the desk is lost: a buy that cannot fill (slippage, sold out,
unknown ticker), a plain payment without a memo, a memo typed wrong — the LTC
is credited to the sender's address and can be claimed. Only a transaction
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
  page shows yours — and the migration mints straight to it. A holder who
  only ever *received* coins by `send` has no key on record: their balance
  is listed as unresolved and parked in a vault address for a signed claim.
- **Freeze.** `NOTUS_LTC_FREEZE=<height>` on the indexer: past that block
  the ledger takes no deploy, buy, sell, send or logo (the LTC they carry is
  credited back); claims and payouts keep working, so the desk settles what
  it owes on Litecoin. The frozen state root is what gets re-created.
- **The file.** `node litecoin/migration-snapshot.ts` turns the frozen
  snapshot into `litecoin/migration/<network>-<height>.json`: per coin the
  curve (virtual and real reserve, sold), creator and holders as EVM
  addresses, balances — scaled from 8 to 18 decimals — plus the LTC to
  bridge (the sum of the curves' real reserves) and what remains to settle
  on Litecoin.
- **The contracts.** `Launchpad.migrateToken` (owner only, once per coin)
  re-creates the coin with that state: `msg.value` is the bridged reserve,
  balances are delivered in batches (`migrateBalances`) and trading opens
  when every holder has theirs, at exactly the ledger's price. A curve that
  had sold out graduates on delivery into a locked Uniswap v2 pool
  (`UniV2Migrator`, LitVM has no v4).

```bash
NOTUS_LTC_FREEZE=<height> node litecoin/indexer.ts     # freeze, publish the frozen snapshot
node litecoin/payout.ts                                # settle what is due on Litecoin
node litecoin/migration-snapshot.ts [--vault 0x...]    # the migration file
# bridge the LTC it says to LitVM, then, from contracts/:
forge script script/DeployLitVM.s.sol --rpc-url litvm_testnet --private-key "$PRIVATE_KEY" --broadcast
LAUNCHPAD=0x... MIGRATION_FILE=../litecoin/migration/test-<height>.json \
  forge script script/MigrateFromLedger.s.sol --rpc-url litvm_testnet --private-key "$PRIVATE_KEY" --broadcast
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
cd web && npm install && cd ..          # the scripts use web/'s dependencies
node litecoin/keygen.ts desk            # once: litecoin/desk/key.json (gitignored) — prints the desk address
# fund the desk with a little LTC for payout fees, then:
node litecoin/indexer.ts --watch        # keep the snapshot fresh (every 60s)
node litecoin/payout.ts                 # pay what is due (add --dry-run to only list)
node --test web/lib/litecoin/*.test.ts  # 16 tests: ledger rules, solvency fuzz, transaction building
```

### On a server (the way to run it for real)

One process does everything — `node litecoin/desk.ts`: an indexer pass every
minute, payouts every other pass, and the snapshot served on `:8787`
(`/state.json`, `/health`). Point the website at it and nothing depends on a
laptop or a commit any more.

```bash
# Ubuntu/Debian VPS, as a user "notus" (never root)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
git clone https://github.com/giupy997/launch-pad.git ~/launch-pad && cd ~/launch-pad
(cd web && npm install)
node litecoin/keygen.ts desk          # or copy your existing litecoin/desk/key.json here (chmod 600)
node litecoin/indexer.ts              # first full sync, prints the desk address
sudo cp litecoin/deploy/notus-desk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now notus-desk
journalctl -u notus-desk -f           # watch it work
```

Put HTTPS in front with Caddy (`litecoin/deploy/Caddyfile`, a DNS record
such as `desk.notuspad.com` pointing at the server), then on Netlify set
`LTC_STATE_URL=https://desk.notuspad.com/state.json` and redeploy: the pages
read the live snapshot through `/api/ltc-state`, and the committed
`web/public/litecoin/state.json` only serves as a fallback. Fund the desk
address with a little LTC for payout fees; back the key file up; the
process exposes only the snapshot, never the key.

Needs Node ≥ 22.18 (runs the TypeScript directly). Environment variables:
`NOTUS_LTC_NETWORK` (`test`, default, or `main`), `NOTUS_LTC_API` (an Esplora
endpoint; default `https://litecoinspace.org/testnet/api`), `NOTUS_LTC_DESK`
(the desk address, for verifiers without the key), `NOTUS_LTC_STATE`,
`NOTUS_LTC_CACHE`, `NOTUS_LTC_CONFIRMATIONS`; for the desk process also
`PORT`, `NOTUS_LTC_INDEX_EVERY`, `NOTUS_LTC_PAYOUT_EVERY`. For the website:
`LTC_STATE_URL` (the desk's snapshot URL), `NEXT_PUBLIC_LTC_NETWORK`,
`LTC_API_UPSTREAM` (where `/api/ltc` forwards), `NEXT_PUBLIC_LTC_API` (to
bypass the proxy).

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
