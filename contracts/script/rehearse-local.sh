#!/bin/bash
# A local rehearsal of the migration to another chain, on one anvil node:
# a pad quoted in a mock cbLTC gets two coins and three holders, freezes,
# migrates out; the snapshot tool reads it at the freeze block; a fresh pad
# receives the coins through MigrateFromLedger; a check compares every holder
# and every price. Needs foundry (anvil, forge, cast) and web/'s node_modules.
#
#   contracts/script/rehearse-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
RPC=http://127.0.0.1:8545
DEPLOYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
MIG=../litecoin/migration
mkdir -p "$MIG"
rm -f "$MIG"/rehearsal-*.json "$MIG"/anvil-*.json

anvil --silent --port 8545 &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 30); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done

echo "== 1. the source pad: coins, holders, a graduation, the freeze announced"
forge script script/rehearsal/RehearseSource.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "^  [A-Za-z]|Error|revert|Reason" || true
PAD=$(node -p "require('$MIG/rehearsal-source.json').launchpad")
QUOTE=$(node -p "require('$MIG/rehearsal-source.json').quote")
FREEZE=$(node -p "require('$MIG/rehearsal-source.json').freezeBlock")

echo "== 2. the chain reaches the freeze (block $FREEZE)"
cast rpc anvil_mine 0x40 --rpc-url $RPC >/dev/null
echo "   chain at $(cast block-number --rpc-url $RPC)"

echo "== 3. the snapshot, at the freeze block"
node script/snapshot-evm.mjs --rpc $RPC --launchpad "$PAD" --quote "$QUOTE" --from-block 0 --network anvil --out "$MIG/anvil-rehearsal.json"

echo "== 4. migrateOut: the quote leaves for the bridging account"
forge script script/rehearsal/RehearseMigrateOut.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "^  [A-Za-z]|Error|revert|Reason" || true

echo "== 5. the receiving pad, and the migration itself (MigrateFromLedger, direct)"
forge script script/rehearsal/RehearseTarget.s.sol --rpc-url $RPC --broadcast 2>&1 | grep -E "^  [A-Za-z]|Error|revert|Reason" || true
TARGET=$(node -p "require('$MIG/rehearsal-target.json').launchpad")
LAUNCHPAD=$TARGET MIGRATION_FILE=$MIG/anvil-rehearsal.json forge script script/MigrateFromLedger.s.sol --rpc-url $RPC --private-key $DEPLOYER --broadcast 2>&1 | grep -E "^  [A-Za-z]|Error|revert|Reason" || true

echo "== 6. the check: every holder, every price"
MIGRATION_FILE=$MIG/anvil-rehearsal.json forge script script/rehearsal/RehearseCheck.s.sol --rpc-url $RPC 2>&1 | grep -E "PASS|Error|revert|Reason" || true
