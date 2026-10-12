#!/bin/bash
# UniV2Migrator v4 on Base: this checkout's migrator (a harvest a slice a
# block on any day, a freeze announced included: SECURITY.md, H-02) deployed
# for the v12 pad, verified on Basescan, and read back. The pad takes it
# through the timelock, from the Safe (timelock.sh safe-calldata
# set-migrator): a coin keeps the migrator it graduated through, so the
# switch comes before any coin graduates on the pad.
#
#   bash script/ops/migrator.sh deploy          # forge create, its Standard JSON input for Basescan, the checks
#   bash script/ops/migrator.sh find            # the migrator the deployer's key deployed last (from its nonce), input and checks
#   bash script/ops/migrator.sh verify 0x...    # submit that input to Basescan (ETHERSCAN_API_KEY in .env)
#   bash script/ops/migrator.sh check 0x...     # read it back: its code, its pad, its router
#
# The pad comes from ADDRESSES (default verify/base-v12/addresses.sh), the
# node from BASE_RPC or SRC_RPC in .env (else foundry's `base`), the signer
# from the keystore ACCOUNT (default `notus`; PRIVATE_KEY for a test key).
# The deployer's key signs the deploy alone: a new contract needs no role;
# only setMigrator on the pad does, and that is the Safe's.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then set -a; source .env; set +a; fi
ADDRESSES=${ADDRESSES:-verify/base-v12/addresses.sh}
# shellcheck disable=SC1090
source "$ADDRESSES"
RPC=${BASE_RPC:-${SRC_RPC:-}}
RPC=${RPC%%,*}
RPC=${RPC:-base}
if [ -n "${PRIVATE_KEY:-}" ]; then SIGNER=(--private-key "$PRIVATE_KEY"); else SIGNER=(--account "${ACCOUNT:-notus}"); fi
UNIV2_ROUTER=0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24 # Uniswap v2 Router02 on Base
INPUT=$(dirname "$ADDRESSES")/UniV2Migrator-v4.standard-input.json
COMPILER="v0.8.24+commit.e11b9ed9"
API="https://api.etherscan.io/v2/api?chainid=8453"

lower() { echo "$1" | tr 'A-F' 'a-f'; }
# a field of the JSON on stdin (forge and cast print it over several lines)
jfield() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=s.slice(s.indexOf("{"),s.lastIndexOf("}")+1);console.log(JSON.parse(t)[process.argv[1]]??"")})' "$1"; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'; }
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k],j);console.log(v==null?"":typeof v==="string"?v:JSON.stringify(v))}catch{console.log("")}})' "$1"; }

# found ADDR: the Standard JSON input for Basescan from this build, the checks, the next steps
found() {
  local addr=$1
  forge build --quiet
  node script/standard-input.mjs src/UniV2Migrator.sol:UniV2Migrator >/dev/null
  cp out/verify/UniV2Migrator.standard-input.json "$INPUT"
  echo "   Standard JSON input written to $INPUT (commit it with the address)"
  check "$addr"
  echo
  echo "next: bash script/ops/migrator.sh verify $addr"
  echo "      bash script/ops/timelock.sh safe-calldata set-migrator   (paste $addr: the Safe schedules it on the timelock)"
  echo "      after the execution, MIGRATOR=$addr in $ADDRESSES"
}

# check ADDR: a migrator of this pad on Base's Uniswap v2, with code
check() {
  local addr=$1 code pad router ok=0
  code=$(cast code "$addr" --rpc-url "$RPC" 2>/dev/null || echo 0x)
  if [ "${#code}" -gt 4 ]; then echo "PASS  code at $addr ($(( (${#code} - 2) / 2 )) bytes)"; else echo "FAIL  no code at $addr"; ok=1; fi
  pad=$(call "$addr" 'launchpad()(address)')
  if [ "$(lower "$pad")" = "$(lower "$PAD")" ]; then echo "PASS  launchpad = the v12 pad $PAD"; else echo "FAIL  launchpad = $pad, want $PAD"; ok=1; fi
  router=$(call "$addr" 'router()(address)')
  if [ "$(lower "$router")" = "$(lower "$UNIV2_ROUTER")" ]; then echo "PASS  router = Uniswap v2 Router02 $UNIV2_ROUTER"; else echo "FAIL  router = $router, want $UNIV2_ROUTER"; ok=1; fi
  echo "      the pad's migrator today: $(call "$PAD" 'migrator()(address)')"
  return $ok
}

case "${1:-}" in
  deploy)
    echo "== UniV2Migrator for the pad $PAD, Uniswap v2 Router02 $UNIV2_ROUTER, from $(git rev-parse --short HEAD)"
    forge build --quiet
    # --constructor-args takes every argument after it, so it comes last
    OUT=$(forge create --rpc-url "$RPC" "${SIGNER[@]}" --broadcast --json src/UniV2Migrator.sol:UniV2Migrator --constructor-args "$PAD" "$UNIV2_ROUTER")
    ADDR=$(echo "$OUT" | jfield deployedTo)
    TX=$(echo "$OUT" | jfield transactionHash)
    [ -n "$ADDR" ] || { echo "forge create answered without an address:"; echo "$OUT"; echo "(if a transaction was sent: bash script/ops/migrator.sh find)"; exit 1; }
    echo "   deployed: $ADDR (tx $TX, block $(cast block-number --rpc-url "$RPC"))"
    found "$ADDR"
    ;;
  find)
    # the last contracts the deployer's key created: the address a deploy lands at is a function of
    # the deployer and the nonce it used, so the latest nonces are tried for a migrator of this pad
    NONCE=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
    echo "== the deployer's key $DEPLOYER is at nonce $NONCE: the contracts of its last transactions"
    ADDR=
    for ((n = NONCE - 1; n >= NONCE - 5 && n >= 0; n--)); do
      CAND=$(cast compute-address "$DEPLOYER" --nonce "$n" | awk '{print $NF}')
      CODE=$(cast code "$CAND" --rpc-url "$RPC" 2>/dev/null || echo 0x)
      [ "${#CODE}" -gt 4 ] || { echo "   nonce $n: $CAND, no contract"; continue; }
      if [ "$(lower "$(call "$CAND" 'launchpad()(address)')")" = "$(lower "$PAD")" ]; then
        echo "   nonce $n: $CAND, a migrator of this pad"
        ADDR=$CAND
        break
      fi
      echo "   nonce $n: $CAND, a contract, not a migrator of this pad"
    done
    [ -n "$ADDR" ] || { echo "no migrator of this pad among the last five contracts of the key"; exit 1; }
    found "$ADDR"
    ;;
  verify)
    ADDR=${2:?address}
    [ -f "$INPUT" ] || { echo "$INPUT is missing: run deploy first (or node script/standard-input.mjs src/UniV2Migrator.sol:UniV2Migrator from the deploying checkout)"; exit 1; }
    : "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY is not set: add it to contracts/.env}"
    ARGS=$(cast abi-encode 'constructor(address,address)' "$PAD" "$UNIV2_ROUTER" | sed 's/^0x//')
    echo "== UniV2Migrator at $ADDR on Basescan"
    if [ -n "$(curl -sS -m 20 "$API&module=contract&action=getsourcecode&address=$ADDR&apikey=$ETHERSCAN_API_KEY" | json "result.0.SourceCode")" ]; then
      echo "   already verified: https://basescan.org/address/$ADDR#code"; exit 0
    fi
    RESP=$(curl -sS -m 90 -X POST "$API" \
      --data-urlencode "apikey=$ETHERSCAN_API_KEY" \
      --data-urlencode "module=contract" \
      --data-urlencode "action=verifysourcecode" \
      --data-urlencode "contractaddress=$ADDR" \
      --data-urlencode "codeformat=solidity-standard-json-input" \
      --data-urlencode "sourceCode@$INPUT" \
      --data-urlencode "contractname=src/UniV2Migrator.sol:UniV2Migrator" \
      --data-urlencode "compilerversion=$COMPILER" \
      --data-urlencode "constructorArguements=$ARGS")
    if [ "$(echo "$RESP" | json status)" != "1" ]; then echo "   submission refused: $(echo "$RESP" | json result) ($(echo "$RESP" | json message))"; exit 1; fi
    GUID=$(echo "$RESP" | json result)
    echo "   submitted, guid $GUID"
    for _ in $(seq 1 24); do
      sleep 5
      ST=$(curl -sS -m 20 "$API&module=contract&action=checkverifystatus&guid=$GUID&apikey=$ETHERSCAN_API_KEY" | json result)
      case "$ST" in *Pending* | "") ;; *) echo "   $ST"; echo "   https://basescan.org/address/$ADDR#code"; exit 0 ;; esac
    done
    echo "   still pending after two minutes: check later at https://basescan.org/address/$ADDR#code"
    ;;
  check)
    check "${2:?address}"
    ;;
  *) sed -n '2,17p' "$0"; exit 1 ;;
esac
