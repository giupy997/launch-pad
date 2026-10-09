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
# Needs foundry, web/'s node_modules (viem), the deployer's signer (the
# encrypted keystore ACCOUNT, default `notus`, asking its password at each
# signature; or PRIVATE_KEY in the environment for a throwaway test key),
# and zkLTC on Liteforge for the deployer: the coins' real reserves (step 3
# prints the figure against the balance and stops when it is short; fund the
# address and rerun with TARGET=<the pad it deployed> to skip step 1).
#
# Variables, all optional: TARGET (a receiving pad to reuse), SRC_RPC, DST_RPC,
# SRC_PAD, SRC_QUOTE, SRC_FROM (the Base pad, its quote, its deploy block),
# POOL_QUOTE_IN (the zkLTC, in wei, the pool buy of step 6 spends: 0.01),
# SCALE (a mechanics-only rehearsal with every quote figure N times smaller,
# for a testnet short of zkLTC: holders and coins stay exact, prices land N
# times lower; the real day runs at 1).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
# .env (SRC_RPC, SRC_CHUNK, and a PRIVATE_KEY for a test key) is read here,
# exported so the snapshot sees SRC_RPC too; a PRIVATE_KEY already in the
# environment wins over the file's
if [ -f .env ]; then
  KEY_GIVEN=${PRIVATE_KEY:-}
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  if [ -n "$KEY_GIVEN" ]; then PRIVATE_KEY=$KEY_GIVEN; fi
  unset KEY_GIVEN
fi
# how to sign: a raw key when one is given, else the encrypted keystore, whose
# password is asked once here and handed to forge and cast as a file in memory
# (--password-file; the steps below capture their output, so a prompt of
# theirs would never show), gone when the script ends however it ends
PWFILE=
trap 'rm -f "${PWFILE:-}"' EXIT
if [ -n "${PRIVATE_KEY:-}" ]; then
  SIGNER=(--private-key "$PRIVATE_KEY")
else
  [ -t 0 ] || { echo "the keystore password is asked at a terminal: run this from one (or set PRIVATE_KEY for a test key)"; exit 1; }
  read -rsp "password of the keystore ${ACCOUNT:-notus}: " KEYSTORE_PASSWORD; echo
  PWFILE=$(mktemp /dev/shm/notus-keystore.XXXXXX)
  printf '%s' "$KEYSTORE_PASSWORD" > "$PWFILE"
  unset KEYSTORE_PASSWORD
  SIGNER=(--account "${ACCOUNT:-notus}" --password-file "$PWFILE")
fi
# The Base nodes for the snapshot, in order; the snapshot falls through them
# when one refuses. Every one must serve the chain's whole history: a node
# that keeps only recent blocks (publicnode) answers a range it does not have
# with an empty list, not an error, and the gap would end the run at the
# add-up check. The public ones no longer serve a long history from a server
# (publicnode and drpc want a key for old blocks, mainnet.base.org rations by
# IP and takes 500 blocks a call), so .env should name a keyed node first and
# SRC_CHUNK the blocks one call may cover on it: Alchemy on Pay As You Go and
# Infura's free plan both take 10,000 blocks a call (Alchemy's free plan
# takes 10, of no use here). The snapshot reads SRC_RPC from the environment
# (not the command line, which the process list shows) and names nodes by
# host; its errors cut every URL to its host, so a key stays out of the logs.
export SRC_RPC=${SRC_RPC:-https://mainnet.base.org}
SRC_CHUNK=${SRC_CHUNK:-499}
DST_RPC=${DST_RPC:-https://liteforge.rpc.caldera.xyz/infra-partner-http}
SRC_PAD=${SRC_PAD:-0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4}
SRC_QUOTE=${SRC_QUOTE:-0xcb17C9Db87B595717C857a08468793f5bAb6445F}
SRC_FROM=${SRC_FROM:-52180589}
# the v7.7 pad's migrator on Liteforge: it knows the DEX router there
OLD_MIGRATOR=0xE34b882BD48D3b13A92C5A7C99469485d1761776
SCALE=${SCALE:-1}
MIG=../litecoin/migration
FILE=$MIG/liteforge-rehearsal.json
mkdir -p "$MIG"
DEPLOYER=$(cast wallet address "${SIGNER[@]}")
echo "deployer $DEPLOYER · source $SRC_PAD on Base · destination Liteforge"

echo "== 0. build"
forge build --silent

echo "== 1. the receiving pad on Liteforge"
if [ -z "${TARGET:-}" ]; then
  ROUTER=$(cast call $OLD_MIGRATOR "router()(address)" --rpc-url "$DST_RPC")
  echo "   DEX router (Lester Labs' Uniswap v2): $ROUTER"
  # a deploy that fails ends the script here, with its last lines shown (an assignment alone would end it silently)
  OUT=$(UNIV2_ROUTER=$ROUTER TREASURY=$DEPLOYER forge script script/DeployLitVM.s.sol --rpc-url "$DST_RPC" "${SIGNER[@]}" --broadcast 2>&1) \
    || { echo "the deploy failed:"; echo "$OUT" | tail -20; exit 1; }
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

echo "== 2. the snapshot of Base: unfrozen, at the latest block, $SRC_CHUNK blocks per request"
node script/snapshot-evm.mjs --launchpad "$SRC_PAD" --quote "$SRC_QUOTE" --from-block "$SRC_FROM" \
  --network base --chunk "$SRC_CHUNK" --allow-unfrozen --vault "$DEPLOYER" --scale "$SCALE" --out "$FILE"

echo "== 3. the zkLTC the coins need, against the deployer's"
NEED=$(node -p "require('$FILE').totals.bridgeLtc")
HAVE=$(cast balance "$DEPLOYER" --rpc-url "$DST_RPC" --ether)
# gas on Liteforge is not nothing (deploying the pad and its migrator cost ~0.16 zkLTC):
# the migration of a few coins and holders wants a margin on top of the coins' reserves
GAS_MARGIN=${GAS_MARGIN:-0.05}
echo "   coins need $NEED zkLTC · deployer has $HAVE zkLTC · gas margin $GAS_MARGIN zkLTC on top"
if awk -v n="$NEED" -v h="$HAVE" -v g="$GAS_MARGIN" 'BEGIN { exit !(h < n + g) }'; then
  echo "   not enough zkLTC on Liteforge: fund $DEPLOYER (the LitVM testnet faucet), then rerun with TARGET=$TARGET"
  exit 2
fi

echo "== 4. the migration (MigrateFromLedger, direct: the deployer owns this pad)"
# a failed step ends the script with its last lines shown and a non-zero status (the grep alone would hide both)
OUT=$(LAUNCHPAD=$TARGET MIGRATION_FILE=$FILE forge script script/MigrateFromLedger.s.sol --rpc-url "$DST_RPC" "${SIGNER[@]}" --broadcast 2>&1) \
  || { echo "the migration failed:"; echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | grep -E "^  [A-Za-z]|->|written|root|Error|revert|Reason" || true

echo "== 5. the check: every holder, every price"
OUT=$(MIGRATION_FILE=$FILE forge script script/rehearsal/RehearseCheck.s.sol --rpc-url "$DST_RPC" 2>&1) \
  || { echo "the check failed:"; echo "$OUT" | grep -E "PASS|FAIL|Error|revert|Reason" || echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | grep -E "PASS|Error|revert|Reason" || true

echo "== 6. NOTUS's twin on its pool (Lester Labs' Uniswap v2): a buy, a sell, a harvest, a transfer, all by the deployer"
OUT=$(SYMBOL=NOTUS SINGLE_SIGNER=true QUOTE_IN=${POOL_QUOTE_IN:-10000000000000000} forge script script/rehearsal/RehearseV12Pool.s.sol --rpc-url "$DST_RPC" "${SIGNER[@]}" --broadcast 2>&1) \
  || { echo "the pool rehearsal failed:"; echo "$OUT" | grep -E "PASS|Error|revert|Reason" || echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | grep -E "^ +[a-z]|PASS|Error|revert|Reason" || true

echo "== done"
echo "   receiving pad   $TARGET"
echo "   migrator        $MIGRATOR"
echo "   deploy block    $DEPLOY_BLOCK"
echo "   coins on it     $(node -p "JSON.stringify(require('$FILE.migrated.json').tokens)" 2>/dev/null || echo "(map not written: see step 4)")"
echo "   snapshot        $FILE"
