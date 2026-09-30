# Migrating the coins from Base to LitVM mainnet

Every coin on the Base launchpad — quoted in cbLTC, on its curve or graduated
into its pool — is re-created on LitVM mainnet with the same holders and the
same price, its pool real, the day LitVM mainnet is live. The launchpad (v8)
was built for it: a **freeze** announced through the timelock stops the pad at
a block, so the snapshot is final; **migrateOut**, also through the timelock,
takes each coin's cbLTC to the account that bridges it; the **snapshot tool**
reads the frozen pad; the **migration script** re-creates the coins on the
other side. Rehearsed end to end on a local chain
(`contracts/script/rehearse-local.sh`, which anyone can run).

What it costs users: about a day of notice during which trading goes on, then
a few hours of stillness while the coins move. What it costs the operator: the
custody of the reserves for those hours, in the open (every step is a timelock
operation, public for the delay before it lands, or a transaction anyone reads).

## What moves, and how

- **A coin on its curve**: its cbLTC reserve leaves whole; on LitVM the curve
  opens with the same virtual and real reserve in zkLTC (8 → 18 decimals,
  1 LTC = 1 LTC), so the price is identical and buying continues.
- **A graduated coin**: the migrator unlocks the pool it seeded (its LP, and
  only its), the cbLTC side leaves, the token side is burned; on LitVM the
  coin graduates again on delivery and its pool is seeded at the same price
  on the DEX there. Liquidity somebody else added to the Base pool stays in
  that pool: once the coin has migrated out, its transfers from the pool are
  free again, so those providers remove their liquidity at will.
- **Holders**: every balance at the freeze block, from the token's Transfer
  logs checked one by one against `balanceOf`, minted to the same address on
  LitVM. Nothing to do on their side.
- **Fees**: cashback and creator fees accrued on Base stay claimable on Base;
  new ones accrue on LitVM.
- **Not migrated**: coins quoted in anything but cbLTC (the pad refuses to
  create them), coins of the first (v7.7) pad, which had no way out and was
  never used.

## 0. Before: what must exist

LitVM mainnet with a public RPC, a Blockscout, its bridge for LTC, and a
Uniswap v2 router for the pools (Lester Labs on Liteforge). A Coinbase account
to turn cbLTC into LTC (sending cbLTC to it credits LTC 1:1). The deployer key
(`contracts/.env`) with zkLTC for gas — bridge some first. The Base pad's
timelock proposer key: the same deployer.

One file holds the names as they arrive; every block below sources it:

```bash
cat > ~/notus-litvm.env <<'EOF2'
export PATH="$HOME/.foundry/bin:$PATH"
export BASE_PAD=            # the v8 Launchpad on Base
export BASE_TIMELOCK=       # its TimelockController
export BASE_QUOTE=0xcb17C9Db87B595717C857a08468793f5bAb6445F
export BASE_FROM_BLOCK=     # the pad's deploy block
export BRIDGE_FROM=         # the EVM account that receives the cbLTC and takes it through Coinbase
export LITVM_RPC=           # LitVM mainnet RPC
export LITVM_PAD=           # step 1
export FREEZE=              # step 2, the block
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

## 2. Announce the freeze (through the timelock)

Pick the freeze block at least one timelock delay of blocks after the moment
the announcement can execute (Base makes a block every 2 s: 24 h ≈ 43,200
blocks), so it can still be cancelled if LitVM is late. Schedule the
announcement and, in the same breath, the migrateOut of every coin, which
only executes once the freeze has landed:

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
Z32=0x0000000000000000000000000000000000000000000000000000000000000000
cast send "$BASE_TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$BASE_PAD" 0 \
  "$(cast calldata 'announceFreeze(uint256)' "$FREEZE")" $Z32 "$(cast keccak "notus-freeze-$FREEZE")" 86400 --rpc-url base --private-key "$PRIVATE_KEY"
for T in $(cast call "$BASE_PAD" "tokenCount()(uint256)" --rpc-url base | xargs seq 0 | head -n -1); do
  COIN=$(cast call "$BASE_PAD" "allTokens(uint256)(address)" $T --rpc-url base)
  cast send "$BASE_TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$BASE_PAD" 0 \
    "$(cast calldata 'migrateOut(address,address)' "$COIN" "$BRIDGE_FROM")" $Z32 "$(cast keccak "notus-out-$FREEZE-$COIN")" 86400 --rpc-url base --private-key "$PRIVATE_KEY"
done
```

24 hours later, execute the announcement (same arguments, `execute(address,
uint256,bytes,bytes32,bytes32)`). The site shows the countdown from then on.
Announce it to holders: trading goes on until the block, then the coins move.

## 3. The freeze lands: snapshot, migrateOut

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts
node script/snapshot-evm.mjs --rpc https://mainnet.base.org --launchpad "$BASE_PAD" --quote "$BASE_QUOTE" \
  --from-block "$BASE_FROM_BLOCK" --network base --out ../litecoin/migration/base-$FREEZE.json
```

It prints every coin with its holders and pool, the LTC to bridge, and the
root; it refuses anything that does not add up. Commit the file: it is the
public record. Then execute every migrateOut operation scheduled in step 2
(they are ready: the delay has passed and the pad is frozen): the cbLTC land
on `BRIDGE_FROM`.

## 4. cbLTC → LTC → zkLTC

Send the cbLTC from `BRIDGE_FROM` to your Coinbase LTC deposit address on the
Base network: Coinbase credits LTC. Withdraw the LTC to the LitVM bridge, to
the deployer's account, and wait for the zkLTC:

```bash
cast balance "$(cast wallet address --private-key "$PRIVATE_KEY")" --rpc-url litvm --ether   # ≥ the file's bridgeLtc plus gas
```

To skip the wait, bridge zkLTC for the expected reserves *before* the freeze
and reimburse yourself from the converted cbLTC afterwards.

## 5. The coins on LitVM

```bash
source ~/notus-litvm.env; cd ~/launch-pad/contracts && source .env
LAUNCHPAD="$LITVM_PAD" MIGRATION_FILE=../litecoin/migration/base-$FREEZE.json forge script script/MigrateFromLedger.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
```

Direct mode, since the pad is the deployer's for the day: the root is set,
every coin created, every holder delivered (150 a transaction), the graduated
ones seed their pools; `base-$FREEZE.json.migrated.json` is written when all
is done. Then the timelock takes the pad, and `closeMigration()` through it.

## 6. Publish

```bash
cp litecoin/migration/base-$FREEZE.json.migrated.json web/public/litecoin/migrated.json
# commit and push: every Base coin page now links its LitVM twin; LitVM becomes the site's default chain
```

## If something goes wrong

- **Before the freeze lands**: `cancelFreeze()` through the timelock (which is
  why the block is chosen a full delay ahead). Nothing has moved.
- **After it lands**: no way back; go forward. `migrateOut` can be retried
  with another `to` if a transfer failed; the snapshot can be taken again at
  the same block, it is deterministic.
- **cbLTC itself**: an issuer's token, pausable and blocklistable by Coinbase.
  That risk exists on every day of the pad's life, not only at the migration.
