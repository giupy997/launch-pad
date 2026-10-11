#!/bin/bash
# The owner's operations on the Base v12 timelock, each one scheduled now and
# executable by anyone after the delay (24 h), from the proposer's key on this
# machine (the keystore ACCOUNT, default `notus`; PRIVATE_KEY for a test key):
#
#   bash script/ops/timelock.sh grant           # an address (a Safe) becomes proposer and canceller too
#   bash script/ops/timelock.sh revoke          # the deployer's key loses both roles: only after the Safe has proven itself
#   bash script/ops/timelock.sh handover        # grant and revoke in one operation: one delay instead of two, for a
#                                               # Safe that has already signed a transaction of its own with two keys
#   bash script/ops/timelock.sh set-treasury    # the pad pays its 0.5% to a new address from the execution on
#   bash script/ops/timelock.sh execute ID      # an operation of this script, once ready (no role needed)
#   bash script/ops/timelock.sh status ID
#   bash script/ops/timelock.sh cancel ID       # the proposer's key, before it executes
#   bash script/ops/timelock.sh safe-calldata set-treasury|revoke
#                                               # the same operations prepared for a Safe that is proposer: the
#                                               # calldata to send to the timelock from the Safe's Transaction
#                                               # Builder; the execution stays a plain command from here
#
# Addresses are asked at the prompt and echoed back checksummed for a yes
# before anything is sent; every scheduled operation is written to
# $NOTUS_OPS_DIR (default ~/notus-ops) by its id, so `execute` and `cancel`
# find their arguments. The timelock is read from verify/base-v12/addresses.sh,
# the node from BASE_RPC or SRC_RPC in .env (else foundry's `base`).
# The watch (ops/watch.mjs) reports every one of these on Telegram as it lands.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then set -a; source .env; set +a; fi
# shellcheck disable=SC1091
source "${ADDRESSES:-verify/base-v12/addresses.sh}"
RPC=${BASE_RPC:-${SRC_RPC:-}}; RPC=${RPC%%,*}; RPC=${RPC:-base}
OPS=${NOTUS_OPS_DIR:-$HOME/notus-ops}
mkdir -p "$OPS"
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
if [ -n "${PRIVATE_KEY:-}" ]; then SIGNER=(--private-key "$PRIVATE_KEY"); else SIGNER=(--account "${ACCOUNT:-notus}"); fi
PROPOSER_ROLE=$(cast keccak "PROPOSER_ROLE")
CANCELLER_ROLE=$(cast keccak "CANCELLER_ROLE")
SIG_SCHEDULE="schedule(address,uint256,bytes,bytes32,bytes32,uint256)"
SIG_SCHEDULE_BATCH="scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)"
SIG_EXECUTE="execute(address,uint256,bytes,bytes32,bytes32)"
SIG_EXECUTE_BATCH="executeBatch(address[],uint256[],bytes[],bytes32,bytes32)"

call() { cast call "$TIMELOCK" "$@" --rpc-url "$RPC"; }
delay() { call "getMinDelay()(uint256)" | awk '{print $1}'; }
when() { date -u -d "@$1" "+%Y-%m-%d %H:%M UTC" 2>/dev/null || date -u -r "$1" "+%Y-%m-%d %H:%M UTC"; }
salt() { cast keccak "notus-ops $1 $(date -u +%Y-%m-%dT%H:%M:%SZ) $RANDOM"; }

# ask LABEL → ADDR (checksummed), after a yes
ask() {
  local raw sum yes
  read -rp "$1 (0x...): " raw
  sum=$(cast to-check-sum-address "$raw" 2>/dev/null) || { echo "not an address: $raw"; exit 1; }
  local code; code=$(cast code "$sum" --rpc-url "$RPC" 2>/dev/null || echo "?")
  echo "   $sum  ($([ "$code" = "0x" ] && echo "no code: a wallet" || echo "a contract, $(( (${#code} - 2) / 2 )) bytes of code"))"
  read -rp "   is this exactly the address you mean? (yes/no): " yes
  [ "$yes" = "yes" ] || { echo "stopped"; exit 1; }
  ADDR=$sum
}

# save KIND ID TARGETS VALUES PAYLOADS PREDECESSOR SALT BATCH(0/1)
save() {
  cat > "$OPS/$2.json" <<EOF
{"kind":"$1","id":"$2","timelock":"$TIMELOCK","targets":"$3","values":"$4","payloads":"$5","predecessor":"$6","salt":"$7","batch":$8,"scheduledAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
}
field() { node -p "require('$OPS/$1.json').$2"; }

# schedule_single KIND TARGET DATA: schedules, saves, prints
schedule_single() {
  local kind=$1 target=$2 data=$3 s id d
  d=$(delay); s=$(salt "$kind")
  id=$(call "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$target" 0 "$data" "$ZERO32" "$s")
  echo "== scheduling $kind on $TIMELOCK (delay $d s)"
  cast send "$TIMELOCK" "$SIG_SCHEDULE" "$target" 0 "$data" "$ZERO32" "$s" "$d" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null
  save "$kind" "$id" "$target" "0" "$data" "$ZERO32" "$s" 0
  done_msg "$id"
}
# schedule_batch KIND "T1,T2" "D1,D2"
schedule_batch() {
  local kind=$1 targets=$2 datas=$3 s id d n values
  d=$(delay); s=$(salt "$kind")
  n=$(echo "$targets" | tr ',' '\n' | wc -l); values=; for ((i = 0; i < n; i++)); do values+="0,"; done; values=${values%,}
  id=$(call "hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32)" "[$targets]" "[$values]" "[$datas]" "$ZERO32" "$s")
  echo "== scheduling $kind on $TIMELOCK (delay $d s)"
  cast send "$TIMELOCK" "$SIG_SCHEDULE_BATCH" "[$targets]" "[$values]" "[$datas]" "$ZERO32" "$s" "$d" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null
  save "$kind" "$id" "$targets" "$values" "$datas" "$ZERO32" "$s" 1
  done_msg "$id"
}
done_msg() {
  local ts; ts=$(call "getTimestamp(bytes32)(uint256)" "$1" | awk '{print $1}')
  echo "   scheduled. id $1"
  echo "   executable from $(when "$ts") by anyone:"
  echo "   bash script/ops/timelock.sh execute $1"
  echo "   (until then the proposer can cancel it: bash script/ops/timelock.sh cancel $1)"
}

case "${1:-}" in
  grant)
    echo "The address below becomes PROPOSER and CANCELLER of the timelock, next to the deployer's key."
    echo "For a Safe: create it first (Base, your owners, threshold 2) and paste its address."
    ask "address to grant"
    D1=$(cast calldata "grantRole(bytes32,address)" "$PROPOSER_ROLE" "$ADDR")
    D2=$(cast calldata "grantRole(bytes32,address)" "$CANCELLER_ROLE" "$ADDR")
    schedule_batch "grant roles to $ADDR" "$TIMELOCK,$TIMELOCK" "$D1,$D2"
    ;;
  handover)
    echo "In one operation: the address below becomes PROPOSER and CANCELLER, and the deployer's key"
    echo "$PROPOSER loses both. From the execution on, only that address schedules and cancels."
    echo "Only for a Safe whose owners and threshold you have read back from the chain, and that has"
    echo "already executed one transaction of its own with two signatures."
    ask "address to hand over to"
    [ "$ADDR" != "$PROPOSER" ] || { echo "that is the deployer's own key"; exit 1; }
    read -rp "   type HANDOVER to go on: " yes; [ "$yes" = HANDOVER ] || { echo "stopped"; exit 1; }
    D1=$(cast calldata "grantRole(bytes32,address)" "$PROPOSER_ROLE" "$ADDR")
    D2=$(cast calldata "grantRole(bytes32,address)" "$CANCELLER_ROLE" "$ADDR")
    D3=$(cast calldata "revokeRole(bytes32,address)" "$PROPOSER_ROLE" "$PROPOSER")
    D4=$(cast calldata "revokeRole(bytes32,address)" "$CANCELLER_ROLE" "$PROPOSER")
    schedule_batch "handover to $ADDR" "$TIMELOCK,$TIMELOCK,$TIMELOCK,$TIMELOCK" "$D1,$D2,$D3,$D4"
    ;;
  revoke)
    echo "The deployer's key $PROPOSER loses PROPOSER and CANCELLER on the timelock."
    echo "Only once the Safe has scheduled AND executed one operation of its own: after this, nothing on"
    echo "this machine can schedule or cancel on the Base timelock any more."
    HAS=$(call "hasRole(bytes32,address)(bool)" "$PROPOSER_ROLE" "$PROPOSER")
    [ "$HAS" = true ] || { echo "   $PROPOSER is not a proposer: nothing to revoke"; exit 1; }
    read -rp "   type REVOKE to go on: " yes; [ "$yes" = REVOKE ] || { echo "stopped"; exit 1; }
    D1=$(cast calldata "revokeRole(bytes32,address)" "$PROPOSER_ROLE" "$PROPOSER")
    D2=$(cast calldata "revokeRole(bytes32,address)" "$CANCELLER_ROLE" "$PROPOSER")
    schedule_batch "revoke roles of $PROPOSER" "$TIMELOCK,$TIMELOCK" "$D1,$D2"
    ;;
  set-treasury)
    echo "The pad $PAD pays its fee to a new address from the execution on."
    echo "Send a few satoshis of cbLTC to it first and see them arrive: an address nobody holds the key to keeps every fee for good."
    ask "new treasury"
    OLD=$(cast call "$PAD" "treasury()(address)" --rpc-url "$RPC")
    echo "   treasury now $OLD"
    schedule_single "setTreasury $ADDR" "$PAD" "$(cast calldata "setTreasury(address)" "$ADDR")"
    ;;
  execute)
    ID=${2:?id}; [ -f "$OPS/$ID.json" ] || { echo "no $OPS/$ID.json: not an operation of this script on this machine"; exit 1; }
    READY=$(call "isOperationReady(bytes32)(bool)" "$ID")
    if [ "$READY" != true ]; then
      TS=$(call "getTimestamp(bytes32)(uint256)" "$ID" | awk '{print $1}')
      case "$TS" in 0) echo "   not scheduled (or cancelled)";; 1) echo "   already executed";; *) echo "   not ready: executable from $(when "$TS")";; esac
      exit 1
    fi
    echo "== executing $(field "$ID" kind)"
    if [ "$(field "$ID" batch)" = 1 ]; then
      cast send "$TIMELOCK" "$SIG_EXECUTE_BATCH" "[$(field "$ID" targets)]" "[$(field "$ID" values)]" "[$(field "$ID" payloads)]" "$(field "$ID" predecessor)" "$(field "$ID" salt)" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null
    else
      cast send "$TIMELOCK" "$SIG_EXECUTE" "$(field "$ID" targets)" 0 "$(field "$ID" payloads)" "$(field "$ID" predecessor)" "$(field "$ID" salt)" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null
    fi
    echo "   executed: $(call "isOperationDone(bytes32)(bool)" "$ID")"
    ;;
  status)
    ID=${2:?id}
    TS=$(call "getTimestamp(bytes32)(uint256)" "$ID" | awk '{print $1}')
    case "$TS" in 0) echo "unknown or cancelled";; 1) echo "done";; *) echo "pending: executable from $(when "$TS") (ready now: $(call "isOperationReady(bytes32)(bool)" "$ID"))";; esac
    [ -f "$OPS/$ID.json" ] && echo "kind: $(field "$ID" kind), scheduled $(field "$ID" scheduledAt)"
    ;;
  cancel)
    ID=${2:?id}
    echo "== cancelling $ID$( [ -f "$OPS/$ID.json" ] && echo " ($(field "$ID" kind))")"
    cast send "$TIMELOCK" "cancel(bytes32)" "$ID" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null
    echo "   cancelled: $([ "$(call "getTimestamp(bytes32)(uint256)" "$ID" | awk '{print $1}')" = 0 ] && echo yes || echo no)"
    ;;
  safe-calldata)
    KIND=${2:?set-treasury|revoke}
    d=$(delay)
    case "$KIND" in
      set-treasury)
        ask "new treasury"
        S=$(salt "safe set-treasury"); DATA=$(cast calldata "setTreasury(address)" "$ADDR")
        ID=$(call "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$PAD" 0 "$DATA" "$ZERO32" "$S")
        save "setTreasury $ADDR (from the Safe)" "$ID" "$PAD" "0" "$DATA" "$ZERO32" "$S" 0
        CALL=$(cast calldata "$SIG_SCHEDULE" "$PAD" 0 "$DATA" "$ZERO32" "$S" "$d")
        ;;
      revoke)
        D1=$(cast calldata "revokeRole(bytes32,address)" "$PROPOSER_ROLE" "$PROPOSER")
        D2=$(cast calldata "revokeRole(bytes32,address)" "$CANCELLER_ROLE" "$PROPOSER")
        S=$(salt "safe revoke")
        ID=$(call "hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32)" "[$TIMELOCK,$TIMELOCK]" "[0,0]" "[$D1,$D2]" "$ZERO32" "$S")
        save "revoke roles of $PROPOSER (from the Safe)" "$ID" "$TIMELOCK,$TIMELOCK" "0,0" "$D1,$D2" "$ZERO32" "$S" 1
        CALL=$(cast calldata "$SIG_SCHEDULE_BATCH" "[$TIMELOCK,$TIMELOCK]" "[0,0]" "[$D1,$D2]" "$ZERO32" "$S" "$d")
        ;;
      *) echo "safe-calldata set-treasury|revoke"; exit 1;;
    esac
    echo "== in the Safe: New transaction → Transaction Builder → custom data"
    echo "   to:    $TIMELOCK"
    echo "   value: 0"
    echo "   data:  $CALL"
    echo "   id:    $ID (saved: once the Safe's transaction is confirmed, after $d s, anyone executes it:"
    echo "   bash script/ops/timelock.sh execute $ID)"
    ;;
  *)
    sed -n '2,20p' "$0"; exit 1;;
esac
