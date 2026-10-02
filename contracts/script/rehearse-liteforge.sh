#!/bin/bash
# A rehearsal of the Base → LitVM migration on the Liteforge testnet, with the
# real Base pad as the source (read-only and unfrozen: a snapshot at the latest
# block, so nothing on Base changes) and a fresh pad on Liteforge as the
# destination. The same tools the day will use: snapshot-evm.mjs reads Base,
# DeployLitVM.s.sol makes the receiving pad, MigrateFromLedger.s.sol re-creates
# the coins, RehearseCheck.s.sol compares every holder and every price.
# Nothing is published to the site: the ticker map it writes stays in
# litecoin/migration/ (publishing it is the real day's step 7).
#
#   cd ~/launch-pad/contracts && bash script/rehearse-liteforge.sh      # reads .env itself
#
# Needs foundry, web/'s node_modules (viem), PRIVATE_KEY in the environment,
# and zkLTC on Liteforge for the deployer: the coins' real reserves (step 3
# prints the figure against the balance and stops when it is short; fund the
# address and rerun with TARGET=<the pad it deployed> to skip step 1).
#
# Variables, all optional: TARGET (a receiving pad to reuse), SRC_RPC, DST_RPC,
# SRC_PAD, SRC_QUOTE, SRC_FROM (the Base pad, its quote, its deploy block).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
# .env sets PRIVATE_KEY without exporting it, so a `source` in the shell does
# not reach this process: read it here when it is missing
if [ -z "${PRIVATE_KEY:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
: "${PRIVATE_KEY:?PRIVATE_KEY is not set and contracts/.env has none}"
# the Base nodes the site uses, in order: the snapshot falls through them when one throttles
SRC_RPC=${SRC_RPC:-https://mainnet.base.org,https://base-rpc.publicnode.com,https://base.drpc.org,https://1rpc.io/base}
DST_RPC=${DST_RPC:-https://liteforge.rpc.caldera.xyz/infra-partner-http}
SRC_PAD=${SRC_PAD:-0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF}
SRC_QUOTE=${SRC_QUOTE:-0xcb17C9Db87B595717C857a08468793f5bAb6445F}
SRC_FROM=${SRC_FROM:-52045689}
# the v7.7 pad's migrator on Liteforge: it knows the DEX router there
OLD_MIGRATOR=0xE34b882BD48D3b13A92C5A7C99469485d1761776
MIG=../litecoin/migration
FILE=$MIG/liteforge-rehearsal.json
mkdir -p "$MIG"
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "deployer $DEPLOYER · source $SRC_PAD on Base · destination Liteforge"

echo "== 0. build"
forge build --silent

echo "== 1. the receiving pad on Liteforge"
if [ -z "${TARGET:-}" ]; then
  ROUTER=$(cast call $OLD_MIGRATOR "router()(address)" --rpc-url "$DST_RPC")
  echo "   DEX router (Lester Labs' Uniswap v2): $ROUTER"
  OUT=$(UNIV2_ROUTER=$ROUTER TREASURY=$DEPLOYER forge script script/DeployLitVM.s.sol --rpc-url "$DST_RPC" --private-key "$PRIVATE_KEY" --broadcast 2>&1)
  echo "$OUT" | grep -E "Launchpad:|UniV2Migrator:|Deploy block:|Error|revert|Reason" || true
  TARGET=$(echo "$OUT" | awk '/Launchpad:/ {print $2}' | tail -1)
  MIGRATOR=$(echo "$OUT" | awk '/UniV2Migrator:/ {print $2}' | tail -1)
  DEPLOY_BLOCK=$(echo "$OUT" | awk '/Deploy block:/ {print $3}' | tail -1)
  [ -n "$TARGET" ] || { echo "no Launchpad address in the deploy output"; echo "$OUT" | tail -20; exit 1; }
else
  MIGRATOR=$(cast call "$TARGET" "migrator()(address)" --rpc-url "$DST_RPC")
  DEPLOY_BLOCK=${DEPLOY_BLOCK:-"(reused pad)"}
fi
# RehearseCheck reads the pad to check from here
printf '{"launchpad":"%s","migrator":"%s"}\n' "$TARGET" "$MIGRATOR" > "$MIG/rehearsal-target.json"
echo "   pad $TARGET · migrator $MIGRATOR · deploy block $DEPLOY_BLOCK"

echo "== 2. the snapshot of Base: unfrozen, at the latest block, 1,999 blocks per request, four nodes"
node script/snapshot-evm.mjs --rpc "$SRC_RPC" --launchpad "$SRC_PAD" --quote "$SRC_QUOTE" --from-block "$SRC_FROM" \
  --network base --chunk 1999 --allow-unfrozen --vault "$DEPLOYER" --out "$FILE"

echo "== 3. the zkLTC the coins need, against the deployer's"
NEED=$(node -p "require('$FILE').totals.bridgeLtc")
HAVE=$(cast balance "$DEPLOYER" --rpc-url "$DST_RPC" --ether)
echo "   coins need $NEED zkLTC · deployer has $HAVE zkLTC (gas comes on top)"
if awk -v n="$NEED" -v h="$HAVE" 'BEGIN { exit !(h < n + 0.05) }'; then
  echo "   not enough zkLTC on Liteforge: fund $DEPLOYER, then rerun with TARGET=$TARGET"
  exit 2
fi

echo "== 4. the migration (MigrateFromLedger, direct: the deployer owns this pad)"
LAUNCHPAD=$TARGET MIGRATION_FILE=$FILE forge script script/MigrateFromLedger.s.sol --rpc-url "$DST_RPC" --private-key "$PRIVATE_KEY" --broadcast 2>&1 \
  | grep -E "^  [A-Za-z]|->|written|root|Error|revert|Reason" || true

echo "== 5. the check: every holder, every price"
MIGRATION_FILE=$FILE forge script script/rehearsal/RehearseCheck.s.sol --rpc-url "$DST_RPC" 2>&1 | grep -E "PASS|Error|revert|Reason" || true

echo "== done"
echo "   receiving pad   $TARGET"
echo "   migrator        $MIGRATOR"
echo "   deploy block    $DEPLOY_BLOCK"
echo "   coins on it     $(node -p "JSON.stringify(require('$FILE.migrated.json').tokens)" 2>/dev/null || echo "(map not written: see step 4)")"
echo "   snapshot        $FILE"
