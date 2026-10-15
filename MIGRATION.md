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
transaction anyone reads), and nothing more: the receiving pad commits to the
snapshot's root (a Merkle tree, a leaf per coin and per holder) a delay ahead,
and from then on delivers only what proves itself a leaf of it, to whom it
names — the operator cannot change a holder, a balance or a coin on the way.

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
with zkLTC for gas — bridge some first. The Base pad's timelock proposer is
the Safe 2-of-3 (`0x934A…d8F4`, since 2026-10-12): the freeze, `migrateOut`
and the operator's nomination are its operations (`timelock.sh
safe-calldata`, the Transaction Builder), executed from the deployer's key
after the delay.

**Since 2026-10-12 the Base timelock's proposer and canceller is the Safe
2-of-3, not the deployer's key.** Every operation on `$BASE_TIMELOCK` below
is therefore a Safe transaction: `timelock.sh safe-calldata <kind>` on the
VPS prints `to`, `value` and `data` for the Safe's Transaction Builder (two
signatures) and saves the operation by its id; 24 hours after the Safe's
confirmation `timelock.sh execute ID` runs it from the VPS (anyone may). The
kinds the move needs exist: `announce-freeze HOURS`, `cancel-freeze`,
`migrate-out`, `set-root FILE`, `set-operator`, `close-migration`,
`abandon-delivery`, and `cancel ID` to withdraw any of them before it is
ready. Before signing, decode the `data` on the Mac (`cast 4byte-decode`)
and compare it with what the VPS printed: the Safe is worth what its signers
read.

One file holds the names as they arrive; every block below sources it. The
Base addresses are v12's (`contracts/verify/base-v12/addresses.sh`): the v11
pad is not touched.

```bash
cat > ~/notus-litvm.env <<'EOF2'
export PATH="$HOME/.foundry/bin:$PATH"
export BASE_PAD=0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5       # the v12 Launchpad on Base
export BASE_TIMELOCK=0xe28f446D3a1DB105F8F9b34A65474E1F6d256f76  # its TimelockController (24 h)
export BASE_MIGRATOR=0x60070f76f885616D675305624497ed0797303434  # its UniV2Migrator (v5, the pad's since 2026-10-15): a coin's own is graduatedVia (step 2)
export BASE_QUOTE=0xcb17C9Db87B595717C857a08468793f5bAb6445F
export BASE_FROM_BLOCK=52397620                                   # the pad's deploy block
export DEPLOYER=0x707f56C25e5d8cc12d08A3bf73f54dBeD0CD9A02        # the keystore notus: executes what the Safe scheduled
export SAFE=0x934A82649b4ca538ff47d9090536837B7092d8F4            # the timelock's proposer and canceller (2 of 3)
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
its address in the env file. The script deploys its TimelockController in the
same run and hands the pad to it before the broadcast ends (`TIMELOCK_DELAY`,
48 hours by default; `PROPOSER`, the Safe), so no block passes with the pad
under a key alone. The migration day needs no owner call: `MIGRATION_OPERATOR`
(the deployer's key on the VPS) names who runs the coins in, and the operator
can deliver only what the committed snapshot proves (step 6). A rehearsal pad
on Liteforge takes `DEPLOYER_OWNED=true` instead and stays the deployer's.

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
so whatever waits in a bucket at the freeze is destroyed, not paid. A harvest
is a slice every five minutes per coin — at most what sells for half a
percent of the pool's quote side, which a trade wrapped around one slice
cannot profit from, and paced so that a price moved against a run of slices
has to be held in the open for minutes a slice — on any day, a freeze
announced included (the Base v12 pad has run this code's v5 since
2026-10-15, before any coin graduated; v4 `0xaB95…fEf1` paced a slice a block,
v3 `0x6f33…40B3` sold the buckets whole under a freeze: a coin keeps the
migrator it graduated through, and none graduated through those).
Anyone may call it (the site has the button; the caller is tipped a
twentieth of the treasury's part). The keeper does it for every graduated
coin until every bucket is empty:

```bash
cd ~/launch-pad/contracts && bash script/ops/harvest.sh --all
```

(`--dry` lists what waits; `--watch` keeps going, a pass a minute, until
Ctrl-C: the loop for the notice. It reads each coin's own migrator
(`graduatedVia`) and its pacing (`nextHarvestAt`), so a coin that graduated
through an older migrator is harvested through that one. By hand, the same
thing, a coin at a time:)

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
COIN=0x...   # the coin
VIA=$(cast call "$BASE_PAD" "graduatedVia(address)(address)" "$COIN" --rpc-url base)   # 0x0: on its curve, no buckets
cast send "$VIA" "harvest(address)" "$COIN" --rpc-url base --account notus   # a slice; again five minutes later
```

Each `cast send` waits for its receipt and the loop a block more, so the
next slice clears the cooldown; a coin's loop ends at the first harvest that
reverts. What is left, coin by coin:

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
  COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
  VIA=$(cast call "$BASE_PAD" "graduatedVia(address)(address)" "$COIN" --rpc-url base)   # the coin's own migrator
  [ "$VIA" != 0x0000000000000000000000000000000000000000 ] || continue   # on its curve: no pool, no buckets
  # coin amounts in the coin's own units (18 decimals); the quote in cbLTC satoshis
  echo "$COIN (migrator $VIA)"
  echo "  taxTreasury:      $(cast call "$BASE_PAD" "taxTreasury(address)(uint256)" "$COIN" --rpc-url base)"
  echo "  taxPot:           $(cast call "$BASE_PAD" "taxPot(address)(uint256)" "$COIN" --rpc-url base)"
  echo "  one capped slice: $(cast call "$VIA" "harvestCap(address)(uint256)" "$COIN" --rpc-url base)"
  # the next harvest simulated, not sent: the coins it takes from both buckets together, what its sale fetches
  if H=$(cast call "$VIA" "harvest(address)(uint256,uint256,uint256)" "$COIN" --from "$DEPLOYER" --rpc-url base); then
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
   cd ~/launch-pad/contracts && bash script/ops/timelock.sh safe-calldata announce-freeze 31
   ```

   The script picks the block (the delay plus 31 hours of notice from now,
   at 2 s a block), prints it and the time it lands: write it in the env
   file as `FREEZE=<that block>`. Then the Safe (Transaction Builder,
   `to`/`data` as printed, two signatures).

   If the execution slips well past the 24 hours (the margin shrinks with
   every hour), withdraw the operation (`safe-calldata cancel ID`, from the
   Safe) and prepare it again with a new `FREEZE` rather than execute it
   late.

2. **Execute it the moment it is ready**, 24 hours after scheduling (same
   arguments, no delay). Run step 2's harvest loop in the last half hour or
   so before that: a day of trading has filled the buckets, and the harvest
   is capped only until this execution. From readiness on anyone may
   execute the operation (the executor role is open), and from that
   execution on the harvest has no cap: the buckets have to be small by the
   time it is ready, not after. When that is:

   ```bash
   cd ~/launch-pad/contracts && bash script/ops/timelock.sh status <id printed by announce-freeze>   # ready from when it says
   ```

   Then:

   ```bash
   cd ~/launch-pad/contracts && bash script/ops/timelock.sh execute <that id>
   ```

   The pad closes to new coins at once — trading goes on until the block — so
   the list is final: prepare the migrateOut of every coin right away, as
   batches of fifteen (one Safe transaction each; a batch executes whole, so
   a coin whose migrateOut would revert — a blocklisted pair — is left out
   with `EXCLUDE=0x...` and goes alone later), ready 24 hours later and
   executable once the freeze has landed. `migrate-out` refuses to run before
   the freeze has landed, so it is prepared then (step 4), not now; what is
   prepared now is the Safe's readiness: signers at hand the day the freeze
   lands.

   Announce it to holders: trading goes on until the block, then the coins
   move; nothing to do on their side. And to liquidity providers: only the
   pool the launchpad seeded can be withdrawn from after the freeze (its
   providers withdraw at will once the coin has migrated out); liquidity in
   any other pool of a coin — another DEX, another pair — can never be
   withdrawn once the freeze block passes, coins or quote. Name the pools the
   dry run found (step 2) and tell their providers to withdraw before the
   block.

3. **Through the notice window, keep the buckets empty.** Leave the keeper
   running on the VPS (`bash script/ops/harvest.sh --watch`, from a tmux
   session): a slice every five minutes per coin, as on any day (288 a day,
   each half a percent of the pool: any bucket empties within the notice),
   so no bucket grows to more than what the last minutes' trades left. On
   a coin that graduated through the Base v12 migrator v3 (`0x6f33…40B3`,
   none did) a harvest under an announced freeze sells both buckets whole
   in one call, so there the keeper matters most: buckets that together
   (`taxTreasury` + `taxPot`) are no larger than one capped slice
   (`harvestCap`) are no more exposed
   than a normal harvest; in the check, the coins the next harvest takes
   are that sum, the figure to keep under `one capped slice`. Just before
   the freeze block, a last pass and the check: `taxTreasury` and `taxPot`
   at dust on every coin (what is left, `migrateOut` burns and the snapshot
   counts as burned); and a last dry run (step 2) to see whether the other
   pools have emptied.

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
cd ~/launch-pad/contracts && bash script/ops/timelock.sh safe-calldata migrate-out   # asks the address: BRIDGE_FROM
```

(the Safe signs it; 24 hours later `timelock.sh execute <id>`; again for the
next fifteen coins until it says every coin is out; a batch that reverts is
prepared again without the coin that reverts, `EXCLUDE=0x...`, and that coin
alone once the cause is gone). The freeze landing and the move out are thus
a day apart at least: the notice in step 3 counts it.

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

First the root, from the Safe: the pad commits to the snapshot (the file's
`stateRoot`, the Merkle tree of its coins and holders, and its freeze block)
once and for good, through the timelock, so it is public a delay before any
coin arrives. The operator cannot set it: it only delivers what it says.

```bash
cd ~/launch-pad/contracts && ADDRESSES=verify/litvm/addresses.sh bash script/ops/timelock.sh safe-calldata set-root ../litecoin/migration/base-$FREEZE.json
```

(the Safe signs it, the delay passes, `execute` from here; the script refuses
a dry-run file). Then the coins, from the operator's key:

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
LAUNCHPAD="$LITVM_PAD" MIGRATION_FILE=../litecoin/migration/base-$FREEZE.json forge script script/MigrateFromLedger.s.sol --rpc-url litvm --account notus --broadcast
```

Direct mode, since the deployer is the pad's migration operator: the script
rebuilds the tree from the file (and refuses one whose root is not its coins',
or that the pad did not commit to), creates every coin with its proof,
delivers every holder with theirs (150 a transaction), the graduated ones seed
their pools; `base-$FREEZE.json.migrated.json` is written when all is done.
The pad checks every proof against the root it committed to, and a holder's
proof names its coin by the coin's own leaf, so the operator's key can deliver
what the snapshot says, to the coin it says, and nothing else; anyone can run
`snapshot-evm.mjs` on the frozen Base pad and compare the root. Then
`closeMigration()` through the timelock (no operator can be named after it).
A coin whose holders can never all be delivered (a snapshot that does not add
up for it) would block every later freeze: `abandonDelivery(token)` through
the timelock burns what was not delivered and lets the pad move on. Coins the
snapshot parked in the vault: hand them back to whom they belong from there,
by hand.

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
  cd ~/launch-pad/contracts && bash script/ops/timelock.sh safe-calldata cancel-freeze
  ```

  Once the Safe has confirmed it, it is armed: from readiness on, anyone may
  execute it up to the freeze block (the executor role is open) and call the
  migration off. So it is not prepared as a hedge, and if the migration goes
  ahead after all the Safe withdraws it before it is ready, which lands at
  once:

  ```bash
  cd ~/launch-pad/contracts && bash script/ops/timelock.sh safe-calldata cancel <the cancel-freeze operation's id>
  ```

  Otherwise, 24 hours later:

  ```bash
  cd ~/launch-pad/contracts && bash script/ops/timelock.sh execute <the cancel-freeze operation's id>
  ```

  No coin has moved; the pad reopens to new coins. Nothing else is pending:
  the migrateOut batches are prepared only once a freeze has landed (step
  4), so no operation waits in the timelock to send cbLTC after some later
  freeze. Any operation of this runbook still pending for another reason is
  withdrawn the same way, `safe-calldata cancel ID` (the ids are in
  `~/notus-ops/`, and the watch names every pending one in its heartbeat).

  Past the last hour a `cancelFreeze` can be scheduled in, the freeze lands:
  go forward.
- **After it lands**: no way back; go forward. `migrateOut` can be retried
  with another `to` if a transfer failed; the snapshot can be taken again at
  the same block, it is deterministic.
- **cbLTC itself**: an issuer's token, pausable and blocklistable by Coinbase.
  That risk exists on every day of the pad's life, not only at the migration;
  a refusal on the day is waited out, the coins' reserves are not lost.
