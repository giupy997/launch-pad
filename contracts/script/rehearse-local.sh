#!/bin/bash
# A local rehearsal of a migration, on one anvil node: a pad quoted in a mock
# cbLTC gets two coins and three holders, freezes, migrates out; the snapshot
# tool reads it at the freeze block; a fresh v12 pad receives the coins through
# MigrateFromLedger; a check compares every holder and every price; then the
# graduated coin's twin is bought, sold and harvested on its pool. Needs
# foundry (anvil, forge, cast) and web/'s node_modules.
#
#   contracts/script/rehearse-local.sh                   # the receiving pad quoted in the native coin (the move to LitVM)
#   DEST=erc20 contracts/script/rehearse-local.sh        # quoted in a mock cbLTC, 8 decimals (the move from Base v11 to v12)
#   MIGRATE_AS=operator contracts/script/rehearse-local.sh   # the migration run by the pad's operator, not its owner
#   FEES=CURVE=100/100/7000/0/0/3000 contracts/script/rehearse-local.sh   # a coin given a tax on the new pad (snapshot --fees)
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC=http://127.0.0.1:${PORT:-8545}
DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0: owns the receiving pad
ALICE=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d      # anvil #1: its migration operator, when asked
DEST=${DEST:-native}
MIGRATE_AS=${MIGRATE_AS:-owner}
MIG=../litecoin/migration
mkdir -p "$MIG"
rm -f "$MIG"/rehearsal-*.json "$MIG"/anvil-*.json

anvil --silent --port "${PORT:-8545}" &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 30); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
show() { grep -E "^  [A-Za-z]|->|PASS|written|root|quote:|Error|revert|Reason" || true; }

echo "== 1. the source pad: coins, holders, a graduation, the freeze announced"
forge script script/rehearsal/RehearseSource.s.sol --rpc-url $RPC --broadcast 2>&1 | show
PAD=$(node -p "require('$MIG/rehearsal-source.json').launchpad")
QUOTE=$(node -p "require('$MIG/rehearsal-source.json').quote")
FREEZE=$(node -p "require('$MIG/rehearsal-source.json').freezeBlock")

echo "== 2. the chain reaches the freeze (block $FREEZE)"
cast rpc anvil_mine 0x40 --rpc-url $RPC >/dev/null
echo "   chain at $(cast block-number --rpc-url $RPC)"

echo "== 3. the receiving pad, quoted in $DEST, the migration run by its $MIGRATE_AS"
DEST_QUOTE=$DEST MIGRATE_AS=$MIGRATE_AS forge script script/rehearsal/RehearseTarget.s.sol --rpc-url $RPC --broadcast 2>&1 | show
TARGET=$(node -p "require('$MIG/rehearsal-target.json').launchpad")
if [ "$DEST" = erc20 ]; then
  SNAP=(--dest-quote "$(node -p "require('$MIG/rehearsal-target.json').quote")" --out-decimals 8)
else
  SNAP=()
fi
if [ "$MIGRATE_AS" = operator ]; then KEY=$ALICE; else KEY=$DEPLOYER; fi
# FEES=SYMBOL=buy/sell/creator/holders/burn/liquidity: a coin relaunched with a tax on the new pad
[ -n "${FEES:-}" ] && SNAP+=(--fees "$FEES")

echo "== 4. the snapshot, at the freeze block"
node script/snapshot-evm.mjs --rpc $RPC --launchpad "$PAD" --quote "$QUOTE" --from-block 0 --network anvil "${SNAP[@]}" --out "$MIG/anvil-rehearsal.json"

echo "== 5. migrateOut: the quote leaves for the bridging account"
forge script script/rehearsal/RehearseMigrateOut.s.sol --rpc-url $RPC --broadcast 2>&1 | show

echo "== 6. the migration itself (MigrateFromLedger, direct)"
LAUNCHPAD=$TARGET MIGRATION_FILE=$MIG/anvil-rehearsal.json forge script script/MigrateFromLedger.s.sol --rpc-url $RPC --private-key "$KEY" --broadcast 2>&1 | show

echo "== 7. the check: every holder, every price"
OUT=$(MIGRATION_FILE=$MIG/anvil-rehearsal.json forge script script/rehearsal/RehearseCheck.s.sol --rpc-url $RPC 2>&1) || { echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | show

echo "== 8. the graduated coin's twin on its pool: a buy, a sell, a harvest, a transfer"
# POOL_SINGLE=1: the deployer plays every part, as the live-testnet rehearsal does (SINGLE_SIGNER)
if [ -n "${POOL_SINGLE:-}" ]; then
  OUT=$(SYMBOL=GRAD MINT_QUOTE=true SINGLE_SIGNER=true forge script script/rehearsal/RehearseV12Pool.s.sol --rpc-url $RPC --private-key $DEPLOYER --broadcast 2>&1) || { echo "$OUT" | tail -30; exit 1; }
else
  OUT=$(SYMBOL=GRAD MINT_QUOTE=true forge script script/rehearsal/RehearseV12Pool.s.sol --rpc-url $RPC --broadcast 2>&1) || { echo "$OUT" | tail -30; exit 1; }
fi
echo "$OUT" | show
