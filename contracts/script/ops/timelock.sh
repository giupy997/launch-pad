#!/bin/bash
# The owner's operations on the Base v12 timelock, each one scheduled now and
# executable by anyone after the delay (24 h). Since the handover of
# 2026-10-12 the only proposer and canceller is the Safe: an operation is
# prepared here as calldata (safe-calldata), signed in the Safe, and executed
# from here once ready; the key on this machine (the keystore ACCOUNT,
# default `notus`; PRIVATE_KEY for a test key) executes, and schedules only
# on a timelock where it still proposes (a rehearsal pad's).
#
#   bash script/ops/timelock.sh safe-calldata set-treasury   # the pad pays its 0.5% to a new address from the execution on
#   bash script/ops/timelock.sh safe-calldata set-migrator   # a migrator deployed with script/ops/migrator.sh, before any coin graduates
#   bash script/ops/timelock.sh safe-calldata revoke         # this machine's key loses PROPOSER and CANCELLER (never the Safe's own)
#   bash script/ops/timelock.sh safe-calldata cancel ID      # a pending operation is withdrawn: the Safe's one move against a wrong one
#   bash script/ops/timelock.sh safe-calldata set-root FILE  # the pad commits to a snapshot's root (its stateRoot and freezeHeight), once
#                                               # each prints the calldata to send to the timelock from the Safe's
#                                               # Transaction Builder (to, value 0, data) and saves the operation by id
#   bash script/ops/timelock.sh execute ID      # an operation of this script, once ready (no role needed)
#   bash script/ops/timelock.sh status ID
#
#   bash script/ops/timelock.sh grant|handover|revoke|set-treasury|cancel ID
#                                               # the same from this machine's key, for a timelock it proposes on
#
# Addresses are asked at the prompt and echoed back checksummed for a yes
# before anything is sent; every scheduled operation is written to
# $NOTUS_OPS_DIR (default ~/notus-ops) by its id, so `execute` and `cancel`
# find their arguments. The timelock is read from verify/base-v12/addresses.sh
# (PROPOSER is the Safe, DEPLOYER this machine's key), the node from BASE_RPC
# or SRC_RPC in .env (else foundry's `base`). The watch (ops/watch.mjs)
# reports every one of these on Telegram as it lands.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then set -a; source .env; set +a; fi
ADDRESSES=${ADDRESSES:-verify/base-v12/addresses.sh}
# shellcheck disable=SC1090
source "$ADDRESSES"
# this machine's key: DEPLOYER where the file names one (Base: PROPOSER is the Safe), else the proposer
KEY=${DEPLOYER:-$PROPOSER}
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
lower() { echo "$1" | tr 'A-F' 'a-f'; }
delay() { call "getMinDelay()(uint256)" | awk '{print $1}'; }
when() { date -u -d "@$1" "+%Y-%m-%d %H:%M UTC" 2>/dev/null || date -u -r "$1" "+%Y-%m-%d %H:%M UTC"; }
salt() { cast keccak "notus-ops $1 $(date -u +%Y-%m-%dT%H:%M:%SZ) $RANDOM"; }

# ask LABEL → ADDR (checksummed), after a yes
ask() {
  local raw sum yes
  read -rp "$1 (0x...): " raw
  sum=$(cast to-check-sum-address "$raw" 2>/dev/null) || { echo "not an address: $raw"; exit 1; }
  [ "$sum" != "0x0000000000000000000000000000000000000000" ] || { echo "the zero address: refused (a pad paying its fee there would stop every trade)"; exit 1; }
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
  echo "   (until then a canceller withdraws it: the Safe, bash script/ops/timelock.sh safe-calldata cancel $1;"
  echo "    this machine's key, where it still cancels: bash script/ops/timelock.sh cancel $1)"
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
    echo "In one operation: the address below becomes PROPOSER and CANCELLER, and this machine's key"
    echo "$KEY loses both. From the execution on, only that address schedules and cancels."
    echo "Only for a Safe whose owners and threshold you have read back from the chain, and that has"
    echo "already executed one transaction of its own with two signatures."
    ask "address to hand over to"
    [ "$ADDR" != "$KEY" ] || { echo "that is this machine's own key"; exit 1; }
    read -rp "   type HANDOVER to go on: " yes; [ "$yes" = HANDOVER ] || { echo "stopped"; exit 1; }
    D1=$(cast calldata "grantRole(bytes32,address)" "$PROPOSER_ROLE" "$ADDR")
    D2=$(cast calldata "grantRole(bytes32,address)" "$CANCELLER_ROLE" "$ADDR")
    D3=$(cast calldata "revokeRole(bytes32,address)" "$PROPOSER_ROLE" "$KEY")
    D4=$(cast calldata "revokeRole(bytes32,address)" "$CANCELLER_ROLE" "$KEY")
    schedule_batch "handover to $ADDR" "$TIMELOCK,$TIMELOCK,$TIMELOCK,$TIMELOCK" "$D1,$D2,$D3,$D4"
    ;;
  revoke)
    echo "This machine's key $KEY loses PROPOSER and CANCELLER on the timelock $TIMELOCK."
    echo "After this, nothing on this machine can schedule or cancel on it any more. With a Safe as proposer:"
    echo "only once the Safe has scheduled AND executed one operation of its own. With no other proposer:"
    echo "nobody ever can again, and the pad $PAD keeps its settings for good (no way back)."
    HAS=$(call "hasRole(bytes32,address)(bool)" "$PROPOSER_ROLE" "$KEY")
    [ "$HAS" = true ] || { echo "   $KEY is not a proposer: nothing to revoke"; exit 1; }
    read -rp "   type REVOKE to go on: " yes; [ "$yes" = REVOKE ] || { echo "stopped"; exit 1; }
    D1=$(cast calldata "revokeRole(bytes32,address)" "$PROPOSER_ROLE" "$KEY")
    D2=$(cast calldata "revokeRole(bytes32,address)" "$CANCELLER_ROLE" "$KEY")
    schedule_batch "revoke roles of $KEY" "$TIMELOCK,$TIMELOCK" "$D1,$D2"
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
    TIMELOCK=$(field "$ID" timelock)  # the one it was scheduled on (v11 or v12), whatever ADDRESSES says now
    READY=$(call "isOperationReady(bytes32)(bool)" "$ID")
    if [ "$READY" != true ]; then
      TS=$(call "getTimestamp(bytes32)(uint256)" "$ID" | awk '{print $1}')
      case "$TS" in 0) echo "   not scheduled (or cancelled)";; 1) echo "   already executed";; *) echo "   not ready: executable from $(when "$TS")";; esac
      exit 1
    fi
    echo "== executing $(field "$ID" kind)"
    # the outcome from the transaction's own receipt: a read right after a send can reach a
    # node still a block behind and answer "not done" for an operation that just was
    if [ "$(field "$ID" batch)" = 1 ]; then
      RECEIPT=$(cast send "$TIMELOCK" "$SIG_EXECUTE_BATCH" "[$(field "$ID" targets)]" "[$(field "$ID" values)]" "[$(field "$ID" payloads)]" "$(field "$ID" predecessor)" "$(field "$ID" salt)" "${SIGNER[@]}" --rpc-url "$RPC" --json)
    else
      RECEIPT=$(cast send "$TIMELOCK" "$SIG_EXECUTE" "$(field "$ID" targets)" 0 "$(field "$ID" payloads)" "$(field "$ID" predecessor)" "$(field "$ID" salt)" "${SIGNER[@]}" --rpc-url "$RPC" --json)
    fi
    STATUS=$(echo "$RECEIPT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s.slice(s.indexOf("{"),s.lastIndexOf("}")+1));console.log((r.status==="0x1"||r.status===1||r.status==="success"?"executed":"REVERTED ("+r.status+")")+" in block "+parseInt(r.blockNumber)+", tx "+r.transactionHash)})')
    echo "   $STATUS"
    ;;
  status)
    ID=${2:?id}
    [ -f "$OPS/$ID.json" ] && TIMELOCK=$(field "$ID" timelock)
    TS=$(call "getTimestamp(bytes32)(uint256)" "$ID" | awk '{print $1}')
    case "$TS" in 0) echo "unknown or cancelled";; 1) echo "done";; *) echo "pending: executable from $(when "$TS") (ready now: $(call "isOperationReady(bytes32)(bool)" "$ID"))";; esac
    [ -f "$OPS/$ID.json" ] && echo "kind: $(field "$ID" kind), scheduled $(field "$ID" scheduledAt)"
    ;;
  cancel)
    ID=${2:?id}
    [ -f "$OPS/$ID.json" ] && TIMELOCK=$(field "$ID" timelock)
    echo "== cancelling $ID$( [ -f "$OPS/$ID.json" ] && echo " ($(field "$ID" kind))") from this machine's key $KEY"
    [ "$(call "hasRole(bytes32,address)(bool)" "$(cast keccak CANCELLER_ROLE)" "$KEY")" = true ] || {
      echo "   $KEY is no canceller on $TIMELOCK (the Safe is): bash script/ops/timelock.sh safe-calldata cancel $ID"; exit 1; }
    cast send "$TIMELOCK" "cancel(bytes32)" "$ID" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null
    echo "   cancelled: $([ "$(call "getTimestamp(bytes32)(uint256)" "$ID" | awk '{print $1}')" = 0 ] && echo yes || echo no)"
    ;;
  safe-calldata)
    KIND=${2:?set-treasury|set-migrator|revoke|cancel ID|set-root FILE}
    d=$(delay)
    case "$KIND" in
      set-root)
        # the migration in: the pad commits to the snapshot's tree once (setMigrationRoot is the
        # owner's), a delay ahead and in the open; the operator then delivers what it says
        FILE=${3:?snapshot file}
        [ -f "$FILE" ] || { echo "no such file: $FILE"; exit 1; }
        ROOT=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(j.dryRun||(j.scale&&j.scale!==1)){console.error("a dry-run file (unfrozen, or scaled): not for a migration");process.exit(1)}console.log("0x"+String(j.stateRoot).replace(/^0x/,""))' "$FILE") || exit 1
        FREEZE=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).freezeHeight' "$FILE")
        [ "$(cast call "$PAD" "migrationRoot()(bytes32)" --rpc-url "$RPC")" = "$ZERO32" ] || { echo "   the pad $PAD holds a root already: $(cast call "$PAD" "migrationRoot()(bytes32)" --rpc-url "$RPC")"; exit 1; }
        echo "The pad $PAD commits to the snapshot $FILE: root $ROOT, frozen at block $FREEZE. Once, for good."
        read -rp "   type ROOT to go on: " yes; [ "$yes" = ROOT ] || { echo "stopped"; exit 1; }
        S=$(salt "safe set-root"); DATA=$(cast calldata "setMigrationRoot(bytes32,uint256)" "$ROOT" "$FREEZE")
        ID=$(call "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$PAD" 0 "$DATA" "$ZERO32" "$S")
        save "setMigrationRoot $ROOT at $FREEZE (from the Safe)" "$ID" "$PAD" "0" "$DATA" "$ZERO32" "$S" 0
        CALL=$(cast calldata "$SIG_SCHEDULE" "$PAD" 0 "$DATA" "$ZERO32" "$S" "$d")
        ;;
      cancel)
        # the one move against a wrong or hostile operation, before it is ready: the Safe is the canceller
        ID=${3:?id}
        [ -f "$OPS/$ID.json" ] && TIMELOCK=$(field "$ID" timelock)
        TS=$(call "getTimestamp(bytes32)(uint256)" "$ID" | awk '{print $1}')
        case "$TS" in
          0) echo "   $ID: not scheduled on $TIMELOCK (or cancelled already)"; exit 1;;
          1) echo "   $ID: executed already, nothing to cancel"; exit 1;;
        esac
        echo "== cancel $ID on $TIMELOCK$( [ -f "$OPS/$ID.json" ] && echo " ($(field "$ID" kind))"): executable from $(when "$TS")"
        echo "== in the Safe: New transaction → Transaction Builder → custom data, then two signatures, before that time"
        echo "   to:    $TIMELOCK"
        echo "   value: 0"
        echo "   data:  $(cast calldata "cancel(bytes32)" "$ID")"
        echo "   check: bash script/ops/timelock.sh status $ID  (unknown or cancelled = done)"
        exit 0
        ;;
      set-migrator)
        echo "The pad $PAD graduates every coin through a new migrator from the execution on (a coin keeps the"
        echo "migrator it graduated through: switch before any coin graduates). One deployed with script/ops/migrator.sh."
        ask "new migrator"
        MPAD=$(cast call "$ADDR" "launchpad()(address)" --rpc-url "$RPC" 2>/dev/null || true)
        [ "$(lower "$MPAD")" = "$(lower "$PAD")" ] || { echo "   $ADDR is not a migrator of this pad (its launchpad: ${MPAD:-none})"; exit 1; }
        OLD=$(cast call "$PAD" "migrator()(address)" --rpc-url "$RPC")
        echo "   migrator now $OLD"
        S=$(salt "safe set-migrator"); DATA=$(cast calldata "setMigrator(address)" "$ADDR")
        ID=$(call "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$PAD" 0 "$DATA" "$ZERO32" "$S")
        save "setMigrator $ADDR (from the Safe)" "$ID" "$PAD" "0" "$DATA" "$ZERO32" "$S" 0
        CALL=$(cast calldata "$SIG_SCHEDULE" "$PAD" 0 "$DATA" "$ZERO32" "$S" "$d")
        ;;
      set-treasury)
        ask "new treasury"
        S=$(salt "safe set-treasury"); DATA=$(cast calldata "setTreasury(address)" "$ADDR")
        ID=$(call "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" "$PAD" 0 "$DATA" "$ZERO32" "$S")
        save "setTreasury $ADDR (from the Safe)" "$ID" "$PAD" "0" "$DATA" "$ZERO32" "$S" 0
        CALL=$(cast calldata "$SIG_SCHEDULE" "$PAD" 0 "$DATA" "$ZERO32" "$S" "$d")
        ;;
      revoke)
        # this machine's key loses both roles; never the Safe's own (a timelock with no proposer and no admin
        # can never be given one again: every setting of the pad would be final)
        [ "$(lower "$KEY")" != "$(lower "$PROPOSER")" ] || { echo "   $KEY is the Safe (PROPOSER in $ADDRESSES): refused"; exit 1; }
        echo "This operation revokes PROPOSER and CANCELLER of this machine's key $KEY on $TIMELOCK; the Safe keeps its own."
        HAS=$(call "hasRole(bytes32,address)(bool)" "$PROPOSER_ROLE" "$KEY")
        [ "$HAS" = true ] || { echo "   $KEY is not a proposer: nothing to revoke"; exit 1; }
        read -rp "   type the last four characters of $KEY to go on: " yes
        [ "$(lower "$yes")" = "$(lower "${KEY: -4}")" ] || { echo "stopped"; exit 1; }
        D1=$(cast calldata "revokeRole(bytes32,address)" "$PROPOSER_ROLE" "$KEY")
        D2=$(cast calldata "revokeRole(bytes32,address)" "$CANCELLER_ROLE" "$KEY")
        S=$(salt "safe revoke")
        ID=$(call "hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32)" "[$TIMELOCK,$TIMELOCK]" "[0,0]" "[$D1,$D2]" "$ZERO32" "$S")
        save "revoke roles of $KEY (from the Safe)" "$ID" "$TIMELOCK,$TIMELOCK" "0,0" "$D1,$D2" "$ZERO32" "$S" 1
        CALL=$(cast calldata "$SIG_SCHEDULE_BATCH" "[$TIMELOCK,$TIMELOCK]" "[0,0]" "[$D1,$D2]" "$ZERO32" "$S" "$d")
        ;;
      *) echo "safe-calldata set-treasury|set-migrator|revoke|cancel ID|set-root FILE"; exit 1;;
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
