#!/bin/bash
# A SlipstreamZapRouter on Base from this checkout — one-transaction ETH buys
# on the curve and, since v2, ETH buys and sales in a graduated coin's pool
# (zapPoolBuy, zapPoolSell) — deployed for the v12 pad, verified on Basescan,
# and read back. The pad does not know its zap: nothing on it changes, no
# timelock operation; the site points at the new one (web/lib/config.ts,
# ZAP_ROUTER and POOL_ZAP) and the old one keeps working for whoever holds
# a transaction to it.
#
#   bash script/ops/zap.sh deploy          # forge create, its Standard JSON input for Basescan, the checks
#   bash script/ops/zap.sh find            # the zap the deployer's key deployed last (from its nonce), input and checks
#   bash script/ops/zap.sh verify 0x...    # submit that input to Basescan (ETHERSCAN_API_KEY in .env)
#   bash script/ops/zap.sh check 0x...     # read it back: its code, its pad, its routers
#
# The pad comes from ADDRESSES (default verify/base-v12/addresses.sh), the
# node from BASE_RPC or SRC_RPC in .env (else foundry's `base`), the signer
# from the keystore ACCOUNT (default `notus`; PRIVATE_KEY for a test key).
# The deployer's key signs the deploy alone: a zap needs no role anywhere.
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
export ETH_RPC_URL=$RPC # cast and forge read it from here: the (keyed) URL stays off every command line
CHAIN=$(cast chain-id 2>/dev/null || echo "?")
[ "$CHAIN" = "${CHAIN_ID:-8453}" ] || { echo "the node answers for chain $CHAIN; this addresses file is for chain ${CHAIN_ID:-8453}"; exit 1; }
if [ -n "${PRIVATE_KEY:-}" ]; then
  # a test key from the environment signs on a test network only: on a live chain the keystore does
  case "$CHAIN" in 1 | 8453) [ "${ALLOW_PRIVATE_KEY:-}" = 1 ] || { echo "PRIVATE_KEY is set in the environment: on chain $CHAIN the keystore signs (unset it, or ALLOW_PRIVATE_KEY=1 to sign with it anyway)"; exit 1; } ;; esac
  SIGNER=(--private-key "$PRIVATE_KEY")
  echo "   signer: $(cast wallet address --private-key "$PRIVATE_KEY") (PRIVATE_KEY from the environment)"
else
  SIGNER=(--account "${ACCOUNT:-notus}")
fi
# Aerodrome Slipstream's SwapRouter (the CL factory 0x5e7BB104…, whose CL200 pool holds cbLTC/WETH) and Base's WETH
SLIPSTREAM_ROUTER=0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5
WETH=0x4200000000000000000000000000000000000006
CONTRACT=src/SlipstreamZapRouter.sol:SlipstreamZapRouter
# the Standard JSON input of a zap, by its address
input_of() { echo "$(dirname "$ADDRESSES")/SlipstreamZapRouter-$(lower "$1").standard-input.json"; }
COMPILER="v0.8.24+commit.e11b9ed9"
API="https://api.etherscan.io/v2/api?chainid=8453"

lower() { echo "$1" | tr 'A-F' 'a-f'; }
# a field of the JSON on stdin (forge and cast print it over several lines)
jfield() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=s.slice(s.indexOf("{"),s.lastIndexOf("}")+1);console.log(JSON.parse(t)[process.argv[1]]??"")})' "$1"; }
call() { cast call "$1" "$2" "${@:3}" 2>/dev/null | awk '{print $1}'; }
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k],j);console.log(v==null?"":typeof v==="string"?v:JSON.stringify(v))}catch{console.log("")}})' "$1"; }

# found ADDR: the Standard JSON input for Basescan from this build, the checks, the next steps
found() {
  local addr=$1 input
  input=$(input_of "$addr")
  if [ -f "$input" ]; then
    echo "   Standard JSON input already there: $input (the record of what $addr was compiled from; not overwritten)"
  else
    forge build --quiet
    node script/standard-input.mjs "$CONTRACT" >/dev/null
    cp out/verify/SlipstreamZapRouter.standard-input.json "$input"
    echo "   Standard JSON input written to $input (commit it with the address; on a machine that does not push,"
    echo "   send it and move it out of the checkout before the next git pull, which brings the committed copy)"
  fi
  check "$addr"
  echo
  echo "next: bash script/ops/zap.sh verify $addr"
  echo "      ZAP=$addr in $ADDRESSES; in web/lib/config.ts ZAP_ROUTER and POOL_ZAP for Base = $addr"
}

# check ADDR: a zap of this pad on Aerodrome Slipstream and Base's WETH, with code
check() {
  local addr=$1 code pad router weth ok=0
  code=$(cast code "$addr" 2>/dev/null || echo 0x)
  if [ "${#code}" -gt 4 ]; then echo "PASS  code at $addr ($(( (${#code} - 2) / 2 )) bytes)"; else echo "FAIL  no code at $addr"; ok=1; fi
  pad=$(call "$addr" 'launchpad()(address)')
  if [ "$(lower "$pad")" = "$(lower "$PAD")" ]; then echo "PASS  launchpad = the v12 pad $PAD"; else echo "FAIL  launchpad = $pad, want $PAD"; ok=1; fi
  router=$(call "$addr" 'swapRouter()(address)')
  if [ "$(lower "$router")" = "$(lower "$SLIPSTREAM_ROUTER")" ]; then echo "PASS  swapRouter = Aerodrome Slipstream $SLIPSTREAM_ROUTER"; else echo "FAIL  swapRouter = $router, want $SLIPSTREAM_ROUTER"; ok=1; fi
  weth=$(call "$addr" 'weth()(address)')
  if [ "$(lower "$weth")" = "$(lower "$WETH")" ]; then echo "PASS  weth = $WETH"; else echo "FAIL  weth = $weth, want $WETH"; ok=1; fi
  # the pool legs: a v2 zap answers a static call of zapPoolSell with its own error (ZeroAmount, 0x1f2a2005),
  # a v1 zap with none (no such selector: empty data); the output is kept whole, since a grep that stops
  # reading would fail the pipeline under pipefail
  local probe
  probe=$(cast call "$addr" 'zapPoolSell(address,uint256,bytes,uint256,uint256)' "$PAD" 0 0x 0 0 2>&1 || true)
  if echo "$probe" | grep -q "ZeroAmount\|0x1f2a2005"; then
    echo "PASS  the pool legs are there (zapPoolBuy, zapPoolSell)"
  else
    echo "FAIL  no pool legs: a zap from before v2"; ok=1
  fi
  echo "      the site's zap today: $ZAP"
  return $ok
}

case "${1:-}" in
  deploy)
    echo "== SlipstreamZapRouter for the pad $PAD, Aerodrome Slipstream $SLIPSTREAM_ROUTER, WETH $WETH, from $(git rev-parse --short HEAD)"
    [ "$(cast code "$SLIPSTREAM_ROUTER" 2>/dev/null | wc -c)" -gt 4 ] || { echo "no Slipstream router at its address: is this Base?"; exit 1; }
    forge build --quiet
    # --constructor-args takes every argument after it, so it comes last
    OUT=$(forge create "${SIGNER[@]}" --broadcast --json "$CONTRACT" --constructor-args "$PAD" "$SLIPSTREAM_ROUTER" "$WETH")
    ADDR=$(echo "$OUT" | jfield deployedTo)
    TX=$(echo "$OUT" | jfield transactionHash)
    [ -n "$ADDR" ] || { echo "forge create answered without an address:"; echo "$OUT"; echo "(if a transaction was sent: bash script/ops/zap.sh find)"; exit 1; }
    echo "   deployed: $ADDR (tx $TX, block $(cast block-number))"
    found "$ADDR"
    ;;
  find)
    # the last contracts the deployer's key created: the address a deploy lands at is a function of
    # the deployer and the nonce it used, so the latest nonces are tried for a zap of this pad
    NONCE=$(cast nonce "$DEPLOYER")
    echo "== the deployer's key $DEPLOYER is at nonce $NONCE: the contracts of its last transactions"
    ADDR=
    for ((n = NONCE - 1; n >= NONCE - 5 && n >= 0; n--)); do
      CAND=$(cast compute-address "$DEPLOYER" --nonce "$n" | awk '{print $NF}')
      CODE=$(cast code "$CAND" 2>/dev/null || echo 0x)
      [ "${#CODE}" -gt 4 ] || { echo "   nonce $n: $CAND, no contract"; continue; }
      if [ "$(lower "$(call "$CAND" 'launchpad()(address)')")" = "$(lower "$PAD")" ] && [ "$(lower "$(call "$CAND" 'swapRouter()(address)')")" = "$(lower "$SLIPSTREAM_ROUTER")" ]; then
        echo "   nonce $n: $CAND, a zap of this pad"
        ADDR=$CAND
        break
      fi
      echo "   nonce $n: $CAND, a contract, not a zap of this pad"
    done
    [ -n "$ADDR" ] || { echo "no zap of this pad among the last five contracts of the key"; exit 1; }
    found "$ADDR"
    ;;
  verify)
    ADDR=${2:?address}
    INPUT=$(input_of "$ADDR")
    [ -f "$INPUT" ] || { echo "$INPUT is missing: run deploy first (or node script/standard-input.mjs $CONTRACT from the deploying checkout)"; exit 1; }
    : "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY is not set: add it to contracts/.env}"
    ARGS=$(cast abi-encode 'constructor(address,address,address)' "$PAD" "$SLIPSTREAM_ROUTER" "$WETH" | sed 's/^0x//')
    echo "== SlipstreamZapRouter at $ADDR on Basescan"
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
      --data-urlencode "contractname=$CONTRACT" \
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
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
