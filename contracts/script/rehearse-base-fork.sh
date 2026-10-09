#!/bin/bash
# A rehearsal of the same-chain move, Base v11 → Base v12, on an anvil fork
# of Base: nothing on Base changes. The fork gets the v12 stack (DeployBase,
# the operator named in the deploy transaction); the v11 timelock is
# impersonated to announce the freeze and, once it lands, to migrate every
# coin out to the operator (the cbLTC each coin holds: a pool's quote side,
# a curve's reserve, the pots); the snapshot reads v11 at the freeze in cbLTC
# units; MigrateFromLedger re-creates the coins on v12, funded in cbLTC by
# the operator; RehearseCheck compares every holder and every price; then
# NOTUS's twin is bought and sold on its real Uniswap v2 pool and harvested
# (RehearseV12Pool), and the migration is closed through the v12 timelock.
# The same tools the day will use, with the delays skipped by impersonation.
#
#   cd ~/launch-pad/contracts && bash script/rehearse-base-fork.sh      # reads .env itself
#
# Needs foundry (anvil, forge, cast), web/'s node_modules (viem), and in
# .env a keyed Base node first in SRC_RPC (the fork reads Base's history
# through it: Alchemy on Pay As You Go takes 10,000 blocks of logs a call,
# SRC_CHUNK) — no signer: anvil's own accounts play every part. Variables,
# all optional: FORK_BLOCK (a fixed block to fork at), PORT (8546), SRC_RPC,
# SRC_CHUNK, V11_PAD, V11_TIMELOCK, V11_FROM.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
SRC_RPC=${SRC_RPC:?set SRC_RPC in contracts/.env (a keyed Base node first)}
FORK_URL=${SRC_RPC%%,*}
SRC_CHUNK=${SRC_CHUNK:-9999}
PORT=${PORT:-8546}
RPC=http://127.0.0.1:$PORT
# Base v11 (README, Deployments)
V11_PAD=${V11_PAD:-0xEfbB4ebdf5130cC4fC45899EeBA727fa2F55b5f4}
V11_TIMELOCK=${V11_TIMELOCK:-0xeDCe189855E9298C3f5b937fE9Ffe8D5261B9EB2}
V11_FROM=${V11_FROM:-52180589}
CBLTC=0xcb17C9Db87B595717C857a08468793f5bAb6445F
TREASURY=0x24622320D93Da2d9c626EE469ad0C2c48a1ED7F7
# anvil's accounts: #0 deploys v12 and is its migration operator (the deployer's
# part on the day); #2 and #3 are Keys.BOB and Keys.CAROL, who trade and harvest
OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OPERATOR=$(cast wallet address --private-key $OPERATOR_KEY)
BOB=$(cast wallet address --private-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a)
MIG=../litecoin/migration
FILE=$MIG/base-fork-rehearsal.json
mkdir -p "$MIG"
rm -f "$FILE" "$FILE.migrated.json"
Z32=0x0000000000000000000000000000000000000000000000000000000000000000
host() { node -e 'console.log(new URL(process.argv[1]).host)' "$1"; }
echo "fork of Base through $(host "$FORK_URL") · v11 pad $V11_PAD · operator $OPERATOR"

echo "== 0. build, and the fork"
forge build --silent
FORK_ARGS=(--fork-url "$FORK_URL" --port "$PORT" --auto-impersonate --silent)
[ -n "${FORK_BLOCK:-}" ] && FORK_ARGS+=(--fork-block-number "$FORK_BLOCK")
anvil "${FORK_ARGS[@]}" &
ANVIL=$!
trap 'kill $ANVIL 2>/dev/null || true' EXIT
for i in $(seq 1 60); do cast block-number --rpc-url $RPC >/dev/null 2>&1 && break; sleep 0.5; done
echo "   fork at block $(cast block-number --rpc-url $RPC)"
# the impersonated accounts pay gas like anyone: a balance for each
for A in $V11_TIMELOCK $TREASURY; do cast rpc anvil_setBalance "$A" 0x8ac7230489e80000 --rpc-url $RPC >/dev/null; done

echo "== 1. the v12 stack on the fork (DeployBase: the operator set in the deploy transaction)"
OUT=$(MIGRATION_OPERATOR=$OPERATOR forge script script/DeployBase.s.sol --rpc-url $RPC --private-key $OPERATOR_KEY --broadcast 2>&1) \
  || { echo "the deploy failed:"; echo "$OUT" | tail -20; exit 1; }
echo "$OUT" | grep -E "Launchpad:|LaunchpadMigration:|UniV2Migrator:|Timelock|Fee \(bps\)|Migration operator|Deploy block:|Error|revert|Reason" || true
V12_PAD=$(echo "$OUT" | awk '/^  Launchpad:/ {print $2}' | tail -1)
V12_MIGRATOR=$(echo "$OUT" | awk '/UniV2Migrator:/ {print $2}' | tail -1)
V12_TIMELOCK=$(echo "$OUT" | awk '/Timelock \(owner\):/ {print $3}' | tail -1)
[ -n "$V12_PAD" ] && [ -n "$V12_MIGRATOR" ] && [ -n "$V12_TIMELOCK" ] || { echo "no addresses in the deploy output"; echo "$OUT" | tail -20; exit 1; }
cast rpc anvil_setBalance "$V12_TIMELOCK" 0x8ac7230489e80000 --rpc-url $RPC >/dev/null
# RehearseCheck and RehearseV12Pool read the pad to check from here
printf '{"launchpad":"%s","migrator":"%s","quote":"%s"}\n' "$V12_PAD" "$V12_MIGRATOR" "$CBLTC" > "$MIG/rehearsal-target.json"

echo "== 2. the freeze on v11, announced by its timelock (impersonated: no 24 hours on a fork)"
COINS=()
COUNT=$(cast call "$V11_PAD" "tokenCount()(uint256)" --rpc-url $RPC)
for ((i = 0; i < COUNT; i++)); do COINS+=("$(cast call "$V11_PAD" "allTokens(uint256)(address)" "$i" --rpc-url $RPC)"); done
echo "   $COUNT coins on v11: ${COINS[*]}"
FREEZE=$(( $(cast block-number --rpc-url $RPC) + 20 ))
cast send "$V11_PAD" "announceFreeze(uint256)" "$FREEZE" --from "$V11_TIMELOCK" --unlocked --rpc-url $RPC >/dev/null
echo "   freeze announced for block $FREEZE (trading goes on until then; on a v12 source this is when every coin is harvested, rush mode)"
cast rpc anvil_mine 0x19 --rpc-url $RPC >/dev/null
echo "   chain at $(cast block-number --rpc-url $RPC): frozen"

echo "== 3. the snapshot of v11 at the freeze, every figure in cbLTC units, $SRC_CHUNK blocks per request"
SRC_RPC=$RPC node script/snapshot-evm.mjs --launchpad "$V11_PAD" --quote "$CBLTC" --from-block "$V11_FROM" --network base \
  --chunk "$SRC_CHUNK" --dest-quote "$CBLTC" --out-decimals 8 --vault "$OPERATOR" --allow-contract-holders --out "$FILE"

echo "== 4. migrateOut on v11 (its timelock, impersonated): the cbLTC of every coin lands on the operator"
for COIN in "${COINS[@]}"; do
  cast send "$V11_PAD" "migrateOut(address,address)" "$COIN" "$OPERATOR" --from "$V11_TIMELOCK" --unlocked --rpc-url $RPC >/dev/null \
    || { echo "   migrateOut of $COIN reverted"; exit 1; }
done
NEED=$(node -p "require('$FILE').totals.bridgeWei")
HAVE=$(cast call "$CBLTC" "balanceOf(address)(uint256)" "$OPERATOR" --rpc-url $RPC | awk '{print $1}')
echo "   the coins need $NEED satoshis of cbLTC · the operator holds $HAVE"
if [ "$HAVE" -lt "$NEED" ]; then
  # the pool's unlock rounds against us by a few satoshis: on the day, a little cbLTC of your own on the operator covers it
  TOP=$(( NEED - HAVE ))
  echo "   short by $TOP satoshis (rounding of the pool's unlock): topped up from the treasury wallet, impersonated"
  cast send "$CBLTC" "transfer(address,uint256)" "$OPERATOR" "$TOP" --from "$TREASURY" --unlocked --rpc-url $RPC >/dev/null
fi

echo "== 5. the migration into v12 (MigrateFromLedger, direct: the operator signs, funds in cbLTC)"
OUT=$(LAUNCHPAD=$V12_PAD MIGRATION_FILE=$FILE forge script script/MigrateFromLedger.s.sol --rpc-url $RPC --private-key $OPERATOR_KEY --broadcast 2>&1) \
  || { echo "the migration failed:"; echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | grep -E "^  [A-Za-z]|->|written|root|quote:|Error|revert|Reason" || true

echo "== 6. the check: every holder, every price"
OUT=$(MIGRATION_FILE=$FILE forge script script/rehearsal/RehearseCheck.s.sol --rpc-url $RPC 2>&1) \
  || { echo "the check failed:"; echo "$OUT" | grep -E "PASS|FAIL|Error|revert|Reason" || echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | grep -E "PASS|Error|revert|Reason" || true

echo "== 7. NOTUS's twin on its real Uniswap v2 pool: a buy, a sell, a harvest, a transfer"
# the buyer's cbLTC comes from the treasury wallet, impersonated (on the day: anyone's)
cast send "$CBLTC" "transfer(address,uint256)" "$BOB" 30000000 --from "$TREASURY" --unlocked --rpc-url $RPC >/dev/null
OUT=$(SYMBOL=NOTUS QUOTE_IN=20000000 forge script script/rehearsal/RehearseV12Pool.s.sol --rpc-url $RPC --broadcast 2>&1) \
  || { echo "the pool rehearsal failed:"; echo "$OUT" | grep -E "PASS|Error|revert|Reason" || echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | grep -E "^ +[a-z]|PASS|Error|revert|Reason" || true

echo "== 8. closeMigration through the v12 timelock (impersonated): the operator's part is over"
cast send "$V12_PAD" "closeMigration()" --from "$V12_TIMELOCK" --unlocked --rpc-url $RPC >/dev/null
echo "   migration closed; operator now $(cast call "$V12_PAD" "migrationOperator()(address)" --rpc-url $RPC)"

echo "== done"
echo "   v12 pad         $V12_PAD (on the fork only)"
echo "   migrator        $V12_MIGRATOR"
echo "   timelock        $V12_TIMELOCK"
echo "   coins on it     $(node -p "JSON.stringify(require('$FILE.migrated.json').tokens)" 2>/dev/null || echo "(map not written: see step 5)")"
echo "   snapshot        $FILE"
