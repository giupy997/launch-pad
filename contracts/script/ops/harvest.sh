#!/bin/bash
# The keeper: harvest every graduated coin's pool fees on a pad, a slice
# every five minutes per coin (the migrator's pacing), until the buckets are
# empty — the loop to run through the notice before a freeze (MIGRATION.md:
# what is still in a bucket when the freeze lands is burned, not paid), or a
# sweep on any day. Anyone may call harvest; the caller is tipped a twentieth
# of the treasury's part. A harvest moves a pool half a percent at most, so a
# trade wrapped around one slice loses, and a run of slices is paced so that
# a price moved against it must be held in the open for minutes a slice: the
# loop may run in the open.
#
#   bash script/ops/harvest.sh           # one pass: every coin, one slice each, if any waits and its five minutes have passed
#   bash script/ops/harvest.sh --all     # again every HARVEST_EVERY seconds (default 60) until every bucket is empty
#   bash script/ops/harvest.sh --watch   # --all, then on: a pass every HARVEST_EVERY seconds until Ctrl-C
#   bash script/ops/harvest.sh --dry     # what waits in the buckets, no transaction
#
# The pad comes from ADDRESSES (default verify/base-v12/addresses.sh), the
# node from BASE_RPC or SRC_RPC in .env (else foundry's `base`), the signer
# from the keystore ACCOUNT (default `notus`; PRIVATE_KEY for a test key).
# A coin whose harvest reverts (its cooldown, a slice too small for the
# pool to mint against) is skipped this pass and tried again on the next. A
# read the node does not answer is said so, never taken for an empty bucket:
# the pass is incomplete and runs again.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then set -a; source .env; set +a; fi
# shellcheck disable=SC1091
source "${ADDRESSES:-verify/base-v12/addresses.sh}"
RPC=${BASE_RPC:-${SRC_RPC:-}}
RPC=${RPC%%,*}
RPC=${RPC:-base}
if [ -n "${PRIVATE_KEY:-}" ]; then SIGNER=(--private-key "$PRIVATE_KEY"); else SIGNER=(--account "${ACCOUNT:-notus}"); fi
MODE=${1:-once}
EVERY=${HARVEST_EVERY:-60}
ZERO=0x0000000000000000000000000000000000000000

# a read of the pad: its first word, or a failure (exit 1) when the node did not answer
call() {
  local out
  out=$(cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>/dev/null) || return 1
  echo "$out" | awk '{print $1}'
}
# the outcome of a send from its receipt: harvested, reverted, or not sent (signer, gas, node)
outcome() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("{");if(i<0){console.log("not sent");return}const r=JSON.parse(s.slice(i,s.lastIndexOf("}")+1));console.log(r.status==="0x1"||r.status===1||r.status==="success"?"harvested":"reverted")})'; }

# one pass over every coin: prints what waits, harvests a slice where something does;
# returns 0 when every bucket is empty, 1 when something still waits, 2 when a read failed
pass() {
  local n i token via a b buckets left=0
  n=$(call "$PAD" 'tokenCount()(uint256)') || { echo "   the node did not answer (tokenCount): pass incomplete"; return 2; }
  for ((i = 0; i < n; i++)); do
    token=$(call "$PAD" 'allTokens(uint256)(address)' "$i") || { echo "   the node did not answer (allTokens $i): pass incomplete"; return 2; }
    via=$(call "$PAD" 'graduatedVia(address)(address)' "$token") || { echo "   the node did not answer (graduatedVia $token): pass incomplete"; return 2; }
    [ "$via" != "$ZERO" ] || continue # on its curve: no pool, no buckets
    a=$(call "$PAD" 'taxTreasury(address)(uint256)' "$token") || { echo "   the node did not answer (taxTreasury $token): pass incomplete"; return 2; }
    b=$(call "$PAD" 'taxPot(address)(uint256)' "$token") || { echo "   the node did not answer (taxPot $token): pass incomplete"; return 2; }
    buckets=$(node -e 'console.log((BigInt(process.argv[1]) + BigInt(process.argv[2])).toString())' "$a" "$b") # wei: past bash's 64 bits
    [ "$buckets" != 0 ] || continue
    left=1
    if [ "$MODE" = "--dry" ]; then
      echo "   $token: $buckets coins wait in its buckets (migrator $via)"
      continue
    fi
    # the migrator's pacing: a slice every five minutes per coin; a send before that would only revert
    due=$(call "$via" 'nextHarvestAt(address)(uint256)' "$token") || due=0
    if [ "$(date -u +%s)" -lt "$due" ]; then
      echo "   $token: $buckets coins wait; the next slice may go at $(date -u -d "@$due" +%H:%M:%S 2>/dev/null || echo "$due") UTC"
      continue
    fi
    case "$(cast send "$via" "harvest(address)" "$token" "${SIGNER[@]}" --rpc-url "$RPC" --json 2>/dev/null | outcome)" in
      harvested) echo "   $token: a slice harvested ($buckets coins waited)";;
      reverted) echo "   $token: harvest reverted this pass (cooldown, or a slice too small): $buckets coins wait";;
      *) echo "   $token: the harvest was NOT sent (the signer, gas, or the node): $buckets coins wait";;
    esac
  done
  return $left
}

echo "== harvest on $PAD through $(node -e 'console.log(new URL(process.argv[1]).host)' "$RPC" 2>/dev/null || echo "$RPC") · block $(cast block-number --rpc-url "$RPC" 2>/dev/null || echo "? (the node did not answer)")"
case "$MODE" in
  once | --dry)
    pass; rc=$?
    case $rc in 0) echo "   every bucket is empty";; 2) exit 2;; esac
    ;;
  --all)
    while :; do
      pass; rc=$?
      [ $rc = 0 ] && break
      [ $rc = 2 ] && echo "   again in $EVERY s"
      sleep "$EVERY"
    done
    echo "   every bucket is empty"
    ;;
  --watch)
    while true; do
      pass; rc=$?
      case $rc in 0) echo "   every bucket is empty ($(date -u +%H:%M:%S) UTC)";; 2) echo "   again in $EVERY s";; esac
      sleep "$EVERY"
    done
    ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
