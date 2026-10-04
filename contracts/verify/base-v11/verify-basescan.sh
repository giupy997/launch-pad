#!/bin/bash
# Verify the Base v11 stack on Basescan (Etherscan's Base explorer) through
# Etherscan's v2 API directly, with the Standard JSON inputs in this folder,
# the ones Blockscout accepted. forge's own verifier is bypassed on purpose:
# this project's foundry.toml points chain 8453 at Blockscout's API (so forge
# saw everything "already verified" there), and forge's client did not speak
# Etherscan's v2 API on the server.
#
# Needs ETHERSCAN_API_KEY in contracts/.env (free: etherscan.io → My API Keys;
# one key serves every chain), never in a chat or a commit.
#
#   cd ~/launch-pad/contracts && bash verify/base-v11/verify-basescan.sh
#
# The addresses come from addresses.sh next to this script, written from the
# deploy script's output (PAD, FACTORY, MIGRATOR, ZAP, TIMELOCK, TREASURY,
# PROPOSER, DELAY); the constructor arguments are encoded from them. The
# LaunchToken of every coin is created by the factory and shares its runtime
# bytecode (the immutables are the pad and the transferable flag, the same
# for every coin of this pad), so once the first coin's is verified Basescan
# shows every other coin's source as a "similar match": pass its address and
# name/symbol as FIRST_TOKEN, FIRST_NAME, FIRST_SYMBOL to verify that one.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
cd ../..
if [ -z "${ETHERSCAN_API_KEY:-}" ] && [ -f .env ]; then set -a; source .env; set +a; fi
: "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY is not set: add it to contracts/.env}"
API="https://api.etherscan.io/v2/api?chainid=8453"
COMPILER="v0.8.24+commit.e11b9ed9"

# one field of a JSON answer on stdin, by dotted path ("result.0.SourceCode")
json() {
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k],j);console.log(v==null?"":typeof v==="string"?v:JSON.stringify(v))}catch{console.log("")}})' "$1"
}

verified() {  # address → true when Basescan already holds the source
  local r
  r=$(curl -sS -m 20 "$API&module=contract&action=getsourcecode&address=$1&apikey=$ETHERSCAN_API_KEY" | json "result.0.SourceCode")
  [ -n "$r" ]
}

verify() {  # address  file  "path:Name"  [constructor args, hex without 0x]
  local addr=$1 file=$HERE/$2 name=$3 args=${4:-}
  echo "== $name at $addr"
  if verified "$addr"; then
    echo "   already verified on Basescan"
    return
  fi
  local resp guid
  resp=$(curl -sS -m 90 -X POST "$API" \
    --data-urlencode "apikey=$ETHERSCAN_API_KEY" \
    --data-urlencode "module=contract" \
    --data-urlencode "action=verifysourcecode" \
    --data-urlencode "contractaddress=$addr" \
    --data-urlencode "codeformat=solidity-standard-json-input" \
    --data-urlencode "sourceCode@$file" \
    --data-urlencode "contractname=$name" \
    --data-urlencode "compilerversion=$COMPILER" \
    --data-urlencode "constructorArguements=$args")
  if [ "$(echo "$resp" | json status)" != "1" ]; then
    echo "   submission refused: $(echo "$resp" | json result) ($(echo "$resp" | json message))"
    return
  fi
  guid=$(echo "$resp" | json result)
  echo "   submitted, guid $guid"
  local st
  for _ in $(seq 1 24); do
    sleep 5
    st=$(curl -sS -m 20 "$API&module=contract&action=checkverifystatus&guid=$guid&apikey=$ETHERSCAN_API_KEY" | json result)
    case "$st" in
      *Pending*|"") ;;
      *) echo "   $st"; return ;;
    esac
  done
  echo "   still pending after two minutes: check later at https://basescan.org/address/$addr#code"
}


set -a; source "$HERE/addresses.sh"; set +a
: "${PAD:?}" "${FACTORY:?}" "${MIGRATOR:?}" "${ZAP:?}" "${TIMELOCK:?}" "${TREASURY:?}" "${PROPOSER:?}" "${DELAY:?}"
export PATH="$HOME/.foundry/bin:$PATH"
enc() { cast abi-encode "$@" | sed 's/^0x//'; }
UNIV2_ROUTER=0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
SLIPSTREAM_ROUTER=0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5
WETH=0x4200000000000000000000000000000000000006

verify "$PAD" Launchpad.standard-input.json "src/Launchpad.sol:Launchpad" "$(enc 'constructor(address)' "$TREASURY")"
verify "$FACTORY" LaunchTokenFactory.standard-input.json "src/LaunchTokenFactory.sol:LaunchTokenFactory"
verify "$MIGRATOR" UniV2Migrator.standard-input.json "src/UniV2Migrator.sol:UniV2Migrator" "$(enc 'constructor(address,address)' "$PAD" "$UNIV2_ROUTER")"
verify "$ZAP" SlipstreamZapRouter.standard-input.json "src/SlipstreamZapRouter.sol:SlipstreamZapRouter" "$(enc 'constructor(address,address,address)' "$PAD" "$SLIPSTREAM_ROUTER" "$WETH")"
verify "$TIMELOCK" TimelockController.standard-input.json "lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController" \
  "$(enc 'constructor(uint256,address[],address[],address)' "$DELAY" "[$PROPOSER]" "[$PROPOSER,0x0000000000000000000000000000000000000000]" 0x0000000000000000000000000000000000000000)"
if [ -n "${FIRST_TOKEN:-}" ]; then
  verify "$FIRST_TOKEN" LaunchToken.standard-input.json "src/LaunchToken.sol:LaunchToken" \
    "$(enc 'constructor(string,string,uint256,bool,address)' "$FIRST_NAME" "$FIRST_SYMBOL" 1000000000000000000000000000 false "$PAD")"
fi
echo "== done: https://basescan.org/address/$PAD#code"
