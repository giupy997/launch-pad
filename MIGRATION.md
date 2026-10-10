# Migrating the coins from Base to LitVM mainnet

Every coin on the Base launchpad — v12, `0x2323…78c5`, quoted in cbLTC, on
its curve or graduated into its pool — is re-created on LitVM mainnet with
the same holders and the same price, its pool real, the day LitVM mainnet is
live. The launchpad was built for it: a **freeze** announced through the
timelock stops the pad at a block, so the snapshot is final — and closes it
to new coins from the announcement on, so the list of coins to move is final
too; **migrateOut**, also through the timelock, takes each coin's cbLTC to
the account that bridges it; the **snapshot tool** reads the frozen pad; the
**migration script** re-creates the coins on the other side. Rehearsed end to
end on a local chain (`contracts/script/rehearse-local.sh`, which anyone can
run), and against the live Base pad on the Liteforge testnet
(`contracts/script/rehearse-liteforge.sh`: an unfrozen snapshot of Base, a
fresh pad on Liteforge, the migration, the check; nothing on Base changes and
nothing is published) — so far from the v11 pad, which the script's defaults
still name: `SRC_PAD=$BASE_PAD SRC_FROM=$BASE_FROM_BLOCK` points it at v12.

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
  on the DEX there. Liquidity somebody else added to that pool stays in it,
  and once the coin has migrated out transfers *out of that pool* are free
  again: those providers remove their liquidity at will (their coins come
  back inert, their cbLTC whole). Nothing can be sold into it or added to
  it: the Base copy of the coin stays frozen for everyone else. **Any other
  pool of the coin** — a pair on another DEX, or against another asset,
  opened by anyone — is not the launchpad's: from the freeze block on
  nothing moves out of it, ever, coins or quote. Its providers withdraw
  before the block (step 3 tells them).
- **Holders**: every balance at the freeze block, from the token's Transfer
  logs checked one by one against `balanceOf`, minted to the same address on
  LitVM. Nothing to do on their side. Coins somebody sent to the pad itself
  (a plain transfer to it passes) have no holder: the snapshot parks them at
  the vault address it is given, for a claim by hand.
- **Fees**: cashback and creator fees accrued on Base stay claimable on Base,
  frozen or not; new ones accrue on LitVM, where each coin keeps its tax and
  its split. The pool fees still waiting in coins at the pad (`taxTreasury`,
  the treasury's 0.5%; `taxPot`, the coin's tax) are paid only by a harvest,
  and `migrateOut` burns whatever is left of them: they are harvested before
  the announcement (step 2).
- **Not part of this move**: the v11 pad (`0xEfbB…5f4`), left running
  untouched with its coins (`LAUNCH-BASE-V12.md`) unless the owner decides
  otherwise — it has its own freeze and `migrateOut` under its own timelock
  (`0xeDCe…9EB2`), and the same tools would move it; the older Base pads,
  retired or never used (README, Deployments). The v12 pad takes cbLTC and
  nothing else as a quote (`DeployBase.s.sol` switches the native quote
  off), so every coin on it moves.

## 0. Before: what must exist

LitVM mainnet with a public RPC, a Blockscout, its bridge for LTC, and a
Uniswap v2 router for the pools (the testnet has several). A Coinbase account
to turn cbLTC into LTC (sending cbLTC to it credits LTC 1:1). The deployer's
keystore (`notus`, `cast wallet import notus`; `contracts/.env` holds no key)
with zkLTC for gas — bridge some first. The Base pad's timelock proposer key:
the same deployer (`0x707f…9A02`).

One file holds the names as they arrive; every block below sources it. The
Base addresses are v12's (`contracts/verify/base-v12/addresses.sh`): the v11
pad is not touched.

```bash
cat > ~/notus-litvm.env <<'EOF2'
export PATH="$HOME/.foundry/bin:$PATH"
export BASE_PAD=0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5       # the v12 Launchpad on Base
export BASE_TIMELOCK=0xe28f446D3a1DB105F8F9b34A65474E1F6d256f76  # its TimelockController (24 h)
export BASE_MIGRATOR=0x6f3303c520dE1a74a664c3EB3045cfb0380d40B3  # its UniV2Migrator: the harvest (step 2)
export BASE_QUOTE=0xcb17C9Db87B595717C857a08468793f5bAb6445F
export BASE_FROM_BLOCK=52397620                                   # the pad's deploy block
export DEPLOYER=0x707f56C25e5d8cc12d08A3bf73f54dBeD0CD9A02        # the keystore notus: the timelock's proposer
export BRIDGE_FROM=         # the EVM account that receives the cbLTC and takes it through Coinbase
export VAULT=               # an account of yours: coins with no holder to go to are parked there (step 2)
export LITVM_RPC=           # LitVM mainnet RPC
export UNIV2_ROUTER=        # the Uniswap v2 router on LitVM the pools open on (step 1)
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
UNIV2_ROUTER="${UNIV2_ROUTER:?set UNIV2_ROUTER in ~/notus-litvm.env}" TREASURY="${TREASURY:?set TREASURY in contracts/.env}" NATIVE_VIRTUAL=50000000000000000000 \
  forge script script/DeployLitVM.s.sol --rpc-url litvm --account notus --broadcast
```

(The router comes from the env file, the treasury from `contracts/.env`; the
shell refuses to run with either missing rather than deploy a pad without a
migrator or with the deployer as treasury.)

`NATIVE_VIRTUAL` is the virtual reserve a zkLTC curve opens with: **50 zkLTC**,
Base v12's 50 cbLTC (v11 opened with 60), so a coin reads the same on both
sides of the migration — ~47.6 of opening market cap, 160 raised to graduate
(the fees on top), ~840 at graduation, the pool opened at that price with
190.48M coins. Migrated coins keep the virtual reserve they had on Base
regardless; the figure is for the coins born on LitVM. The script deploys
this checkout's `UniV2Migrator`, whose harvest decides its liquidity leg on
the exact amounts: the few-satoshi revert of the Base v12 migrator (step 2)
is not in it.

Verify it (Blockscout, `script/standard-input.mjs` if the CLI stalls) and put
its address in the env file. It is owned by the deployer for the migration
day, so the coins are created the hour the snapshot exists; the timelock takes
it over right after (`DeployTimelock.s.sol` with `LAUNCHPAD=$LITVM_PAD`, its
48-hour default).

## 2. Before scheduling anything: the checks, the harvest

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && set -a && source .env && set +a
# a dry run of the snapshot at the latest block: it refuses whatever would not add up on the day
node script/snapshot-evm.mjs --chunk "${SRC_CHUNK:?set SRC_CHUNK in contracts/.env}" --launchpad "$BASE_PAD" --quote "$BASE_QUOTE" \
  --from-block "$BASE_FROM_BLOCK" --network base --allow-unfrozen --vault "$VAULT" --out /tmp/base-dryrun.json
```

`SRC_RPC` and `SRC_CHUNK` come from `contracts/.env` (`.env.example` explains
them): the Base nodes the snapshot reads, a keyed one first and every one
serving the whole history, and the blocks one call may span on it. The
snapshot reads `SRC_RPC` from the environment (`set -a` exports it), so the
keyed URL never sits in a command line; the shell refuses to run without
`SRC_CHUNK` rather than hand the snapshot an empty range. The public nodes
refuse the pad's whole history from a server, so a snapshot on
`https://mainnet.base.org` alone stalls on the day.

Read its warnings: coins parked in the vault (another provider's share of
the launchpad's pool, coins sent to the pad) are yours to hand back by hand
afterwards; coins of unsold pool fees are for the harvest below, run now,
while it is capped, not once a freeze is announced. A holder that is a
contract stops the run, named in its error: on LitVM nothing would answer at
that address. Most likely it is **another pool of the coin** — on
base.blockscout.com a pair contract (`token0`, `token1`, `factory`) on
another DEX or against another asset — whose liquidity the freeze locks for
good: note every one for the announcement (step 3), then add
`--allow-contract-holders` to the dry run to read the rest of it. Then
cbLTC itself, an issuer's token Coinbase can pause and blocklist: on
base.blockscout.com read its `paused()` and, for the pad, the migrator and
every graduated coin's pair (`pairOf(token)` on the migrator), its blocklist
check (`isBlacklisted(address)` in its verified source). A paused cbLTC or a
blocklisted address makes `migrateOut` revert — nothing is lost, it is
retried later or with another `to`, but the day is better without. Make sure
`BRIDGE_FROM` is an account you control and that Coinbase takes cbLTC from it.

### The pool fees: harvest them while the harvest is capped

A graduated coin's pool trades leave their fees in coins at the pad, in two
buckets: `taxTreasury` (the launchpad's 0.5%, the treasury's) and `taxPot`
(the coin's tax: its creator's, holders', burn and liquidity shares). Only a
harvest sells them and pays them out; `migrateOut` burns what is still there,
so whatever waits in a bucket at the freeze is destroyed, not paid. And from
the announcement's execution on, the harvest runs in a rush: no cooldown, no
cap, one call sells both buckets whole at the pool's price with no minimum,
so large buckets can be sandwiched (a sell, the harvest, the buy back, in one
transaction). So the buckets are emptied now, in normal mode: one slice a
block, at most what sells for half a percent of the pool's quote side, which
a trade wrapped around it cannot profit from. Anyone may call it (the site
has the button; the caller is tipped a twentieth of the treasury's part).
Every graduated coin, until its harvest reverts:

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
  COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
  # a coin on its curve has no pool and no buckets
  [ "$(cast call "$BASE_PAD" "graduatedVia(address)(address)" "$COIN" --rpc-url base)" = "$BASE_MIGRATOR" ] || continue
  while cast send "$BASE_MIGRATOR" "harvest(address)" "$COIN" --rpc-url base --account notus >/dev/null; do
    echo "$COIN: a slice harvested"
    sleep 3   # one a block: the node estimates the next one on its latest block
  done
  echo "$COIN: the last harvest reverted"
done
```

Each `cast send` waits for its receipt and the loop a block more, so the
next slice clears the cooldown; a coin's loop ends at the first harvest that
reverts. What is left, coin by coin:

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
  COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
  [ "$(cast call "$BASE_PAD" "graduatedVia(address)(address)" "$COIN" --rpc-url base)" = "$BASE_MIGRATOR" ] || continue
  # coin amounts in the coin's own units (18 decimals); the quote in cbLTC satoshis
  echo "$COIN"
  echo "  taxTreasury:      $(cast call "$BASE_PAD" "taxTreasury(address)(uint256)" "$COIN" --rpc-url base)"
  echo "  taxPot:           $(cast call "$BASE_PAD" "taxPot(address)(uint256)" "$COIN" --rpc-url base)"
  echo "  one capped slice: $(cast call "$BASE_MIGRATOR" "harvestCap(address)(uint256)" "$COIN" --rpc-url base)"
  # the next harvest simulated, not sent: the coins it takes from both buckets together, what its sale fetches
  if H=$(cast call "$BASE_MIGRATOR" "harvest(address)(uint256,uint256,uint256)" "$COIN" --from "$DEPLOYER" --rpc-url base); then
    echo "  the next harvest takes $(echo "$H" | sed -n 1p) and fetches $(echo "$H" | sed -n 2p) satoshis"
  else
    echo "  the next harvest reverts (the error above): dust, or one landed in the last block"
  fi
done
```

What stays is dust, or close to it: the check's next harvest reverts, with
`NothingToSell` (the buckets sell for less than a satoshi) or, on the Base
v12 migrator, with the pair's `UniswapV2: INSUFFICIENT_LIQUIDITY_MINTED` (a
little above dust, below). A coin whose check shows a harvest that goes
through and fetches more than a few tens of satoshis did not finish — a
trade since, or its loop stopped on a failure of another kind:
`HarvestCooldown` (a node a block behind, or another caller in the same
block), a mistyped password, no ETH for gas. Run the loop again for it.

On the Base v12 migrator a harvest can also revert a little above dust, and
only for a coin with a liquidity share. The harvest keeps half that share as
coins and sells the other half, to add both to the pool, and decides whether
the pool would mint for them on an estimate: the sold half priced on its own
against the pool. When that half is worth just over a satoshi, the estimate
says the pool mints while the actual amounts — the half's part of the larger,
floored sale, against the reserves the sale leaves — give it no cbLTC; the
pair's `mint` refuses and the whole harvest reverts with it. The two
buckets are then worth twenty to thirty satoshis together for a coin with a
1 to 10% tax giving a tenth of its pot to liquidity; more for a lower tax or
a smaller share (about forty at 0.5%, a hundred and twenty at 0.1%), a few
for a coin giving its whole pot to liquidity. Nothing moves and nothing is
lost: the next trade on the pool adds tax, the buckets change size, and the
harvest goes through again; left at the freeze, they are dust that
`migrateOut` burns. The repository's `UniV2Migrator.sol` decides that leg on
the exact amounts — when the pool would mint nothing, the whole share is
sold and its cbLTC goes to the burn pot — and the LitVM pad deploys it
(step 1); a deployed contract does not change, so the Base v12 migrator
keeps its code (`contracts/verify/base-v12/`).

## 3. Announce the freeze (through the timelock)

Two timelock rounds of 24 hours, with the coin list closing between them:

1. **Schedule the announcement**, with every bucket at dust (step 2). The
   freeze block is part of the calldata, so it is chosen now; counted from
   the current block (Base makes one every 2 s), it must leave room for the
   24 hours until the announcement can execute, then for one more delay so
   the migrateOut operations scheduled at the execution are ready when the
   freeze lands, and for a margin during which a `cancelFreeze` (24 hours to
   land itself) can still be scheduled. 100,000 blocks (~55 h) does it:
   about 31 h of public notice on the site, which shows the countdown from
   the execution on.

   ```bash
   source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
   FREEZE=$(( $(cast block-number --rpc-url base) + 100000 )); echo "FREEZE=$FREEZE"   # write it in the env file
   Z32=0x0000000000000000000000000000000000000000000000000000000000000000
   cast send "$BASE_TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$BASE_PAD" 0 \
     "$(cast calldata 'announceFreeze(uint256)' "$FREEZE")" $Z32 "$(cast keccak "notus-freeze-$FREEZE")" 86400 --rpc-url base --account notus
   ```

   If the execution slips well past the 24 hours (the margin shrinks with
   every hour), cancel the operation (`cancel(bytes32)` on the timelock,
   proposer only; its id is the timelock's `hashOperation` of the same
   arguments, as under *If something goes wrong*) and schedule again with a
   new `FREEZE` rather than execute it late.

2. **Execute it the moment it is ready**, 24 hours after scheduling (same
   arguments, no delay). Run step 2's harvest loop in the last half hour or
   so before that: a day of trading has filled the buckets, and the harvest
   is capped only until this execution. From readiness on anyone may
   execute the operation (the executor role is open), and from that
   execution on the harvest has no cap: the buckets have to be small by the
   time it is ready, not after. When that is:

   ```bash
   source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
   Z32=0x0000000000000000000000000000000000000000000000000000000000000000
   ID=$(cast call "$BASE_TIMELOCK" "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$BASE_PAD" 0 \
     "$(cast calldata 'announceFreeze(uint256)' "$FREEZE")" $Z32 "$(cast keccak "notus-freeze-$FREEZE")" --rpc-url base)
   date -d @"$(cast call "$BASE_TIMELOCK" "getTimestamp(bytes32)(uint256)" "$ID" --rpc-url base | cut -d' ' -f1)"   # ready from then on
   ```

   Then:

   ```bash
   source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
   Z32=0x0000000000000000000000000000000000000000000000000000000000000000
   cast send "$BASE_TIMELOCK" "execute(address,uint256,bytes,bytes32,bytes32)" "$BASE_PAD" 0 \
     "$(cast calldata 'announceFreeze(uint256)' "$FREEZE")" $Z32 "$(cast keccak "notus-freeze-$FREEZE")" --rpc-url base --account notus
   ```

   The pad closes to new coins at once — trading goes on until the block — so
   the list is final: schedule the migrateOut of every coin right away, each
   its own operation, ready 24 hours later and executable once the freeze has
   landed:

   ```bash
   source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
   Z32=0x0000000000000000000000000000000000000000000000000000000000000000
   for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
     COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
     cast send "$BASE_TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$BASE_PAD" 0 \
       "$(cast calldata 'migrateOut(address,address)' "$COIN" "$BRIDGE_FROM")" $Z32 "$(cast keccak "notus-out-$FREEZE-$COIN")" 86400 --rpc-url base --account notus
   done
   ```

   Announce it to holders: trading goes on until the block, then the coins
   move; nothing to do on their side. And to liquidity providers: only the
   pool the launchpad seeded can be withdrawn from after the freeze (its
   providers withdraw at will once the coin has migrated out); liquidity in
   any other pool of a coin — another DEX, another pair — can never be
   withdrawn once the freeze block passes, coins or quote. Name the pools the
   dry run found (step 2) and tell their providers to withdraw before the
   block.

3. **Through the notice window, keep the buckets small.** The harvest now
   runs in a rush, both buckets sold whole in one call, so buckets left to
   grow are a sandwich waiting. Run step 2's harvest loop every hour or so
   and after any large trade (anyone may, the site's button too): each
   harvest now empties a coin's buckets at once. Buckets that together
   (`taxTreasury` + `taxPot`) are no larger than one capped slice
   (`harvestCap`) are no more exposed than a normal harvest; in the check,
   the coins the next harvest takes are that sum, the figure to keep under
   `one capped slice`. Just before the freeze block, the loop once more and
   the check: `taxTreasury` and `taxPot` at dust on every coin (what is
   left, `migrateOut` burns and the snapshot counts as burned); and a last
   dry run (step 2) to see whether the other pools have emptied.

## 4. The freeze lands: snapshot, migrateOut

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && set -a && source .env && set +a
node script/snapshot-evm.mjs --chunk "${SRC_CHUNK:?set SRC_CHUNK in contracts/.env}" --launchpad "$BASE_PAD" --quote "$BASE_QUOTE" \
  --from-block "$BASE_FROM_BLOCK" --network base --vault "$VAULT" --out ../litecoin/migration/base-$FREEZE.json
```

It prints every coin with its holders and pool, the LTC to bridge, and the
root; it refuses anything that does not add up. A pool other than the
launchpad's that still holds coins stops it as in the dry run: its providers
did not withdraw, and what they left is stuck on Base for good;
`--allow-contract-holders` lists the pool as a holder anyway, its coins
minted on LitVM to an address where nothing answers — the owner's call.
Commit the file: it is the public record. Then execute every migrateOut
operation scheduled in step 3 (they are ready: the delay has passed and the
pad is frozen): the cbLTC land on `BRIDGE_FROM`, and each coin's buckets, at
dust, are burned. Each is its own operation, so one that reverts (a paused
cbLTC, a blocklisted pair) holds up no other; it is retried later, with
another `to` if need be — nothing is marked on a revert.

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
Z32=0x0000000000000000000000000000000000000000000000000000000000000000
for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
  COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
  cast send "$BASE_TIMELOCK" "execute(address,uint256,bytes,bytes32,bytes32)" "$BASE_PAD" 0 \
    "$(cast calldata 'migrateOut(address,address)' "$COIN" "$BRIDGE_FROM")" $Z32 "$(cast keccak "notus-out-$FREEZE-$COIN")" --rpc-url base --account notus \
    || echo "migrateOut of $COIN reverted: retry it later, or schedule it again with another to"
done
```

## 5. cbLTC → LTC → zkLTC

Send the cbLTC from `BRIDGE_FROM` to your Coinbase LTC deposit address on the
Base network: Coinbase credits LTC. Withdraw the LTC to the LitVM bridge, to
the deployer's account, and wait for the zkLTC:

```bash
cast balance "$(cast wallet address --account notus)" --rpc-url litvm --ether   # ≥ the file's bridgeLtc plus gas
```

To skip the wait, bridge zkLTC for the expected reserves *before* the freeze
and reimburse yourself from the converted cbLTC afterwards.

## 6. The coins on LitVM

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
LAUNCHPAD="$LITVM_PAD" MIGRATION_FILE=../litecoin/migration/base-$FREEZE.json forge script script/MigrateFromLedger.s.sol --rpc-url litvm --account notus --broadcast
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
  the freeze block (the margin in step 3 is for that), and it must execute
  before the block:

  ```bash
  source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
  Z32=0x0000000000000000000000000000000000000000000000000000000000000000
  cast send "$BASE_TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$BASE_PAD" 0 \
    "$(cast calldata 'cancelFreeze()')" $Z32 "$(cast keccak "notus-unfreeze-$FREEZE")" 86400 --rpc-url base --account notus
  ```

  Once scheduled it is armed: from readiness on, anyone may execute it up to
  the freeze block (the executor role is open) and call the migration off.
  So it is not scheduled as a hedge, and if the migration goes ahead after
  all the proposer cancels it before it is ready, with `cancel(bytes32)`,
  which lands at once:

  ```bash
  source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
  Z32=0x0000000000000000000000000000000000000000000000000000000000000000
  cast send "$BASE_TIMELOCK" "cancel(bytes32)" "$(cast call "$BASE_TIMELOCK" "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$BASE_PAD" 0 \
    "$(cast calldata 'cancelFreeze()')" $Z32 "$(cast keccak "notus-unfreeze-$FREEZE")" --rpc-url base)" --rpc-url base --account notus
  ```

  Otherwise, 24 hours later (same arguments, no delay):

  ```bash
  source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
  Z32=0x0000000000000000000000000000000000000000000000000000000000000000
  cast send "$BASE_TIMELOCK" "execute(address,uint256,bytes,bytes32,bytes32)" "$BASE_PAD" 0 \
    "$(cast calldata 'cancelFreeze()')" $Z32 "$(cast keccak "notus-unfreeze-$FREEZE")" --rpc-url base --account notus
  ```

  No coin has moved; the pad reopens to new coins and the harvest gets its
  cap back. But the migrateOut operations scheduled in step 3 are still in
  the timelock: an OpenZeppelin operation never expires and anyone may
  execute one that is ready, so after any later freeze each would send its
  coin's cbLTC to this `BRIDGE_FROM`. Once the cancellation has executed
  (`cast call "$BASE_PAD" "freezeBlock()(uint256)" --rpc-url base` reads 0)
  and before any other freeze is scheduled, the proposer cancels every one of
  them: `cancel(bytes32)`, which lands at once. An operation's id is the
  timelock's hash of the arguments it was scheduled with, so this runs with
  the env file's `FREEZE` and `BRIDGE_FROM` as they were then:

  ```bash
  source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
  Z32=0x0000000000000000000000000000000000000000000000000000000000000000
  for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
    COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
    ID=$(cast call "$BASE_TIMELOCK" "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$BASE_PAD" 0 \
      "$(cast calldata 'migrateOut(address,address)' "$COIN" "$BRIDGE_FROM")" $Z32 "$(cast keccak "notus-out-$FREEZE-$COIN")" --rpc-url base)
    if [ "$(cast call "$BASE_TIMELOCK" "isOperationPending(bytes32)(bool)" "$ID" --rpc-url base)" = true ]; then
      cast send "$BASE_TIMELOCK" "cancel(bytes32)" "$ID" --rpc-url base --account notus
    else
      echo "$COIN: no migrateOut operation pending ($ID)"
    fi
  done
  ```

  Past the last hour a `cancelFreeze` can be scheduled in, the freeze lands:
  go forward.
- **After it lands**: no way back; go forward. `migrateOut` can be retried
  with another `to` if a transfer failed; the snapshot can be taken again at
  the same block, it is deterministic.
- **cbLTC itself**: an issuer's token, pausable and blocklistable by Coinbase.
  That risk exists on every day of the pad's life, not only at the migration;
  a refusal on the day is waited out, the coins' reserves are not lost.
