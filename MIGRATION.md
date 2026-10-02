# Migrating the coins from Base to LitVM mainnet

Every coin on the Base launchpad — quoted in cbLTC, on its curve or graduated
into its pool — is re-created on LitVM mainnet with the same holders and the
same price, its pool real, the day LitVM mainnet is live. The launchpad (v9)
was built for it: a **freeze** announced through the timelock stops the pad at
a block, so the snapshot is final — and closes it to new coins from the
announcement on, so the list of coins to move is final too; **migrateOut**,
also through the timelock, takes each coin's cbLTC to the account that bridges
it; the **snapshot tool** reads the frozen pad; the **migration script**
re-creates the coins on the other side. Rehearsed end to end on a local chain
(`contracts/script/rehearse-local.sh`, which anyone can run), and against the
live Base pad on the Liteforge testnet (`contracts/script/rehearse-liteforge.sh`:
an unfrozen snapshot of Base, a fresh pad on Liteforge, the migration, the
check; nothing on Base changes and nothing is published).

What it costs users: about a day of notice during which trading goes on (no
new coins), then a few hours of stillness while the coins move. What it costs
the operator: the custody of the reserves for those hours, in the open (every
step is a timelock operation, public for the delay before it lands, or a
transaction anyone reads).

## What moves, and how

- **A coin on its curve**: its cbLTC reserve leaves whole, its unspent pots
  (buyback, liquidity) with it; on LitVM the curve opens with the same
  virtual and real reserve in zkLTC (8 → 18 decimals, 1 LTC = 1 LTC), the
  same fee configuration, the same burn (what was bought back and burned on
  Base is burned again at birth) and the same pots, so the price is
  identical and buying continues.
- **A graduated coin**: the migrator unlocks the pool it seeded (its LP, and
  only its), the cbLTC side leaves, the token side is burned; on LitVM the
  coin graduates again on delivery and its pool is seeded at the same price
  on the DEX there. Liquidity somebody else added to the Base pool stays in
  that pool, and once the coin has migrated out transfers *out of that pool*
  are free again: those providers remove their liquidity at will (their coins
  come back inert, their cbLTC whole). Nothing can be sold into it or added
  to it: the Base copy of the coin stays frozen for everyone else.
- **Holders**: every balance at the freeze block, from the token's Transfer
  logs checked one by one against `balanceOf`, minted to the same address on
  LitVM. Nothing to do on their side. Coins somebody sent to the pad itself
  (a plain transfer to it passes) have no holder: the snapshot parks them at
  the vault address it is given, for a claim by hand.
- **Fees**: cashback and creator fees accrued on Base stay claimable on Base,
  frozen or not; new ones accrue on LitVM.
- **Not migrated**: coins of the first (v7.7) pad, which had no way out and
  was never used. The v8 pad on Base takes cbLTC and nothing else as a quote
  (the native quote is switched off at deploy), so every coin on it moves.

## 0. Before: what must exist

LitVM mainnet with a public RPC, a Blockscout, its bridge for LTC, and a
Uniswap v2 router for the pools (the testnet has several). A Coinbase account
to turn cbLTC into LTC (sending cbLTC to it credits LTC 1:1). The deployer key
(`contracts/.env`) with zkLTC for gas — bridge some first. The Base pad's
timelock proposer key: the same deployer.

One file holds the names as they arrive; every block below sources it:

```bash
cat > ~/notus-litvm.env <<'EOF2'
export PATH="$HOME/.foundry/bin:$PATH"
export BASE_PAD=0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF       # the v9 Launchpad on Base
export BASE_TIMELOCK=0x24dc2a849D3dbD93d8051d6C8d3215Be718B6Dd8  # its TimelockController (24 h)
export BASE_QUOTE=0xcb17C9Db87B595717C857a08468793f5bAb6445F
export BASE_FROM_BLOCK=52045689                                   # the pad's deploy block
export BRIDGE_FROM=         # the EVM account that receives the cbLTC and takes it through Coinbase
export VAULT=               # an account of yours: coins with no holder to go to are parked there (step 2)
export LITVM_RPC=           # LitVM mainnet RPC
export LITVM_PAD=           # step 1
export FREEZE=              # step 3, the block
EOF2
chmod 600 ~/notus-litvm.env
```

Add `litvm` to `contracts/foundry.toml` (`[rpc_endpoints]` and `[etherscan]`)
and the chain to `web/lib/config.ts` and the site's CSP, as for any new chain.

## 1. The receiving pad on LitVM

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
UNIV2_ROUTER=<router> TREASURY=<treasury> forge script script/DeployLitVM.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
```

Verify it (Blockscout, `script/standard-input.mjs` if the CLI stalls) and put
its address in the env file. It is owned by the deployer for the migration
day, so the coins are created the hour the snapshot exists; the timelock takes
it over right after (`DeployTimelock.s.sol` with `LAUNCHPAD=$LITVM_PAD`).

## 2. Before scheduling anything: the checks

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts
# a dry run of the snapshot at the latest block: it refuses whatever would not add up on the day
node script/snapshot-evm.mjs --rpc https://mainnet.base.org --launchpad "$BASE_PAD" --quote "$BASE_QUOTE" \
  --from-block "$BASE_FROM_BLOCK" --network base --allow-unfrozen --vault "$VAULT" --out /tmp/base-dryrun.json
```

Read its warnings: coins parked in the vault (another provider's share of a
pool, coins sent to the pad) are yours to hand back by hand afterwards. Then
cbLTC itself, an issuer's token Coinbase can pause and blocklist: on
base.blockscout.com read its `paused()` and, for the pad, the migrator and
every graduated coin's pair (`pairOf(token)` on the migrator), its blocklist
check (`isBlacklisted(address)` in its verified source). A paused cbLTC or a
blocklisted address makes `migrateOut` revert — nothing is lost, it is
retried later or with another `to`, but the day is better without. Make sure
`BRIDGE_FROM` is an account you control and that Coinbase takes cbLTC from it.

## 3. Announce the freeze (through the timelock)

Two timelock rounds of 24 hours, with the coin list closing between them:

1. **Schedule the announcement.** The freeze block is part of the calldata,
   so it is chosen now; counted from the current block (Base makes one every
   2 s), it must leave room for the 24 hours until the announcement can
   execute, then for one more delay so the migrateOut operations scheduled at
   the execution are ready when the freeze lands, and for a margin during
   which a `cancelFreeze` (24 hours to land itself) can still be scheduled.
   100,000 blocks (~55 h) does it: about 31 h of public notice on the site,
   which shows the countdown from the execution on.

   ```bash
   source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
   FREEZE=$(( $(cast block-number --rpc-url base) + 100000 )); echo "FREEZE=$FREEZE"   # write it in the env file
   Z32=0x0000000000000000000000000000000000000000000000000000000000000000
   cast send "$BASE_TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$BASE_PAD" 0 \
     "$(cast calldata 'announceFreeze(uint256)' "$FREEZE")" $Z32 "$(cast keccak "notus-freeze-$FREEZE")" 86400 --rpc-url base --private-key "$PRIVATE_KEY"
   ```

   If the execution slips well past the 24 hours (the margin shrinks with
   every hour), cancel the operation (`cancel(bytes32)` on the timelock,
   proposer only) and schedule again with a new `FREEZE` rather than execute
   it late.

2. **Execute it, 24 hours later** (same arguments, `execute(address,uint256,
   bytes,bytes32,bytes32)`). The pad closes to new coins at once — trading
   goes on until the block — so the list is final: schedule the migrateOut of
   every coin right away, each its own operation, ready 24 hours later and
   executable once the freeze has landed:

   ```bash
   source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
   Z32=0x0000000000000000000000000000000000000000000000000000000000000000
   for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
     COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
     cast send "$BASE_TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$BASE_PAD" 0 \
       "$(cast calldata 'migrateOut(address,address)' "$COIN" "$BRIDGE_FROM")" $Z32 "$(cast keccak "notus-out-$FREEZE-$COIN")" 86400 --rpc-url base --private-key "$PRIVATE_KEY"
   done
   ```

   Announce it to holders: trading goes on until the block, then the coins
   move; nothing to do on their side.

## 4. The freeze lands: snapshot, migrateOut

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts
node script/snapshot-evm.mjs --rpc https://mainnet.base.org --launchpad "$BASE_PAD" --quote "$BASE_QUOTE" \
  --from-block "$BASE_FROM_BLOCK" --network base --vault "$VAULT" --out ../litecoin/migration/base-$FREEZE.json
```

It prints every coin with its holders and pool, the LTC to bridge, and the
root; it refuses anything that does not add up. Commit the file: it is the
public record. Then execute every migrateOut operation scheduled in step 3
(they are ready: the delay has passed and the pad is frozen): the cbLTC land
on `BRIDGE_FROM`. Each is its own operation, so one that reverts (a paused
cbLTC, a blocklisted pair) holds up no other; it is retried later, with
another `to` if need be — nothing is marked on a revert.

## 5. cbLTC → LTC → zkLTC

Send the cbLTC from `BRIDGE_FROM` to your Coinbase LTC deposit address on the
Base network: Coinbase credits LTC. Withdraw the LTC to the LitVM bridge, to
the deployer's account, and wait for the zkLTC:

```bash
cast balance "$(cast wallet address --private-key "$PRIVATE_KEY")" --rpc-url litvm --ether   # ≥ the file's bridgeLtc plus gas
```

To skip the wait, bridge zkLTC for the expected reserves *before* the freeze
and reimburse yourself from the converted cbLTC afterwards.

## 6. The coins on LitVM

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
LAUNCHPAD="$LITVM_PAD" MIGRATION_FILE=../litecoin/migration/base-$FREEZE.json forge script script/MigrateFromLedger.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
```

Direct mode, since the pad is the deployer's for the day: the root is set,
every coin created, every holder delivered (150 a transaction), the graduated
ones seed their pools; `base-$FREEZE.json.migrated.json` is written when all
is done. Then the timelock takes the pad, and `closeMigration()` through it.
Coins the snapshot parked in the vault: hand them back to whom they belong
from there, by hand.

## 7. Publish

```bash
mkdir -p web/public/migrated && cp litecoin/migration/base-$FREEZE.json.migrated.json web/public/migrated/8453.json
# commit and push: every Base coin page now links its LitVM twin; LitVM becomes the site's default chain
```

## If something goes wrong

- **Before the freeze lands**: `cancelFreeze()` through the timelock — it
  takes the delay to land, so it can be scheduled only up to 24 hours before
  the freeze block (the margin in step 3 is for that). Nothing has moved; the
  pad reopens to new coins. Past that point the freeze lands: go forward.
- **After it lands**: no way back; go forward. `migrateOut` can be retried
  with another `to` if a transfer failed; the snapshot can be taken again at
  the same block, it is deterministic.
- **cbLTC itself**: an issuer's token, pausable and blocklistable by Coinbase.
  That risk exists on every day of the pad's life, not only at the migration;
  a refusal on the day is waited out, the coins' reserves are not lost.
