#!/bin/bash
# The keeper: harvest every graduated coin's pool fees on a pad, a slice a
# block per coin, until the buckets are empty — the loop to run through the
# notice before a freeze (MIGRATION.md: what is still in a bucket when the
# freeze lands is burned, not paid), or a sweep on any day. Anyone may call
# harvest; the caller is tipped a twentieth of the treasury's part. A harvest
# moves a pool half a percent at most, so a trade wrapped around it cannot
# profit: the loop may run in the open.
#
#   bash script/ops/harvest.sh           # one pass: every coin, one slice each, if any waits
#   bash script/ops/harvest.sh --all     # again every few seconds (HARVEST_EVERY, default 4) until every bucket is empty
#   bash script/ops/harvest.sh --watch   # --all, then on: a pass every HARVEST_EVERY seconds until Ctrl-C
#   bash script/ops/harvest.sh --dry     # what waits in the buckets, no transaction
#
# The pad comes from ADDRESSES (default verify/base-v12/addresses.sh), the
# node from BASE_RPC or SRC_RPC in .env (else foundry's `base`), the signer
# from the keystore ACCOUNT (default `notus`; PRIVATE_KEY for a test key).
# A coin whose harvest reverts (its cooldown, a slice too small for the
# pool to mint against) is skipped this pass and tried again on the next.
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
EVERY=${HARVEST_EVERY:-4}
ZERO=0x0000000000000000000000000000000000000000

call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'; }

# one pass over every coin: prints what waits, harvests a slice where something does;
# returns 0 when every bucket is empty, 1 when something still waits
pass() {
  local n i token via buckets left=0
  n=$(call "$PAD" 'tokenCount()(uint256)')
  for ((i = 0; i < n; i++)); do
    token=$(call "$PAD" 'allTokens(uint256)(address)' "$i")
    via=$(call "$PAD" 'graduatedVia(address)(address)' "$token")
    [ "$via" != "$ZERO" ] || continue # on its curve: no pool, no buckets
    buckets=$(( $(call "$PAD" 'taxTreasury(address)(uint256)' "$token") + $(call "$PAD" 'taxPot(address)(uint256)' "$token") ))
    [ "$buckets" != 0 ] || continue
    left=1
    if [ "$MODE" = "--dry" ]; then
      echo "   $token: $buckets coins wait in its buckets (migrator $via)"
      continue
    fi
    if cast send "$via" "harvest(address)" "$token" "${SIGNER[@]}" --rpc-url "$RPC" >/dev/null 2>&1; then
      echo "   $token: a slice harvested ($buckets coins waited)"
    else
      echo "   $token: harvest reverted this pass (cooldown, or a slice too small): $buckets coins wait"
    fi
  done
  return $left
}

echo "== harvest on $PAD through $(node -e 'console.log(new URL(process.argv[1]).host)' "$RPC" 2>/dev/null || echo "$RPC") · block $(cast block-number --rpc-url "$RPC")"
case "$MODE" in
  once | --dry)
    if pass; then echo "   every bucket is empty"; fi
    ;;
  --all)
    until pass; do sleep "$EVERY"; done
    echo "   every bucket is empty"
    ;;
  --watch)
    while true; do
      if pass; then echo "   every bucket is empty ($(date -u +%H:%M:%S) UTC)"; fi
      sleep "$EVERY"
    done
    ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
