# Notus on Zcash

Zcash has no smart contracts, so this launchpad is not a contract: it is one
shielded address (the **desk**), its **published viewing key**, and a set of
rules replayed over the encrypted memos people send to it. Same chain, same
rules, same answer — anyone can rebuild every balance and check the state root.

Currently on the **Zcash testnet** (TAZ has no value).

## How it works

| Piece | Where | What it does |
|---|---|---|
| The rules | `web/lib/zcash/ledger.ts` | Pure, deterministic: ordered memos in → coins, balances, fees, payouts and a state root out. The Zcash counterpart of `Launchpad.sol`. |
| Indexer | `zcash/indexer.ts` | Syncs the desk wallet (`zcash-devtool`), reads the memos from its database, replays the rules, writes `web/public/zcash/state.json`. |
| Spend path | `zcash/payout.ts` | Sends what the ledger says is due (sell proceeds, claims), each with a `NOTUS1 paid <id>` memo — the payment itself marks it settled. |
| Website | `web/app/zcash/*` | Explore, deploy, trade, wallet, ledger. Builds the memos and payment requests (ZIP-321 link + QR); signs sells and claims in the browser. |
| Test user | `zcash/user.ts` | Does from a CLI wallet what the site asks a person to do — for end-to-end tests. |

Balances belong to a **holder key** (ed25519, made in the browser): shielded
senders are anonymous, so a buy names the key to credit and anything that
spends a balance carries that key's signature (with a nonce against replay,
and the network inside the signed message).

### Memos (`NOTUS1 …`, space separated, ≤ 512 bytes)

```
deploy TICKER name holder c|h [logoUrl]      value ≥ 0.001 ZEC; the excess is a dev buy
buy    TICKER holder [minOut]                value = the ZEC to spend
sell   TICKER amount minZat payoutAddr holder nonce sig
send   TICKER amount toHolder holder nonce sig
claim  payoutAddr holder nonce sig           creator fees + holder cashback + refunds
paid   payoutId                              desk only: settles a payout
```

Curve and fees mirror the EVM launchpad: constant product with virtual
reserves (0.3 ZEC on testnet, 3 ZEC on mainnet), 1B supply with 800M on the
curve, 1% fee split 20% desk / 80% to the creator **or** the holders (fixed at
deploy; pro-rata accumulator, debts rounded up so claims never exceed the pot).
There is no DEX to graduate to: the curve stays the market, a sell always
fills, and the last 200M are reserved for Zcash Shielded Assets.

A buy that cannot fill (slippage, sold out, unknown ticker) is not lost: the
ZEC is credited to the holder key and can be claimed.

## What is custodial

The desk holds the ZEC in the curves — there is no escrow on Zcash — and the
ledger is the only record of balances. That is the trade-off of the design,
stated on the site's ledger page. The viewing key lets anyone audit it; it
cannot spend.

## Run it

```bash
# once: build the wallet tool (needs Rust)
git clone https://github.com/zcash/zcash-devtool zcash/tool && (cd zcash/tool && cargo build --release)
# once: create the desk wallet (seed is age-encrypted; zcash/desk is gitignored)
mkdir -p zcash/desk && zcash/tool/target/release/zcash-devtool wallet -w zcash/desk init --name notus-desk -i zcash/desk/identity.txt -n test

node zcash/indexer.ts --watch     # keep the snapshot fresh
node zcash/payout.ts              # pay what is due (add --dry-run to only list)
node --test web/lib/zcash/ledger.test.ts
```

Needs Node ≥ 22.18 (runs the TypeScript directly, uses `node:sqlite`).
`node zcash/demo-state.ts` writes a synthetic snapshot to look at the UI with
no chain activity; the indexer overwrites it.
