#!/bin/bash
# Verify the Base v9 stack on Basescan (Etherscan's Base explorer) through
# Etherscan's v2 API directly, with the Standard JSON inputs in this folder,
# the ones Blockscout accepted. forge's own verifier is bypassed on purpose:
# this project's foundry.toml points chain 8453 at Blockscout's API (so forge
# saw everything "already verified" there), and forge's client did not speak
# Etherscan's v2 API on the server.
#
# Needs ETHERSCAN_API_KEY in contracts/.env (free: etherscan.io → My API Keys;
# one key serves every chain), never in a chat or a commit.
#
#   cd ~/launch-pad/contracts && bash verify/base-v9/verify-basescan.sh
#
# The LaunchToken of every coin is created by the factory and shares its
# runtime bytecode with Notus's (the immutables are the pad and the
# transferable flag, the same for every coin of this pad), so once Notus's is
# verified Basescan shows every other coin's source as a "similar match".
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

verify 0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF Launchpad.standard-input.json "src/Launchpad.sol:Launchpad" \
  00000000000000000000000024622320d93da2d9c626ee469ad0c2c48a1ed7f7
verify 0x0287eD7e89b1D7B69Db08B16020341151E93F530 LaunchTokenFactory.standard-input.json "src/LaunchTokenFactory.sol:LaunchTokenFactory"
verify 0x92329D494D4D098C95A87E381a4D60CA666edb1b UniV2Migrator.standard-input.json "src/UniV2Migrator.sol:UniV2Migrator" \
  000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef0000000000000000000000004752ba5dbc23f44d87826276bf6fd6b1c372ad24
verify 0x2C3861638055A82782B8d30471c153B2DA00e756 SlipstreamZapRouter.standard-input.json "src/SlipstreamZapRouter.sol:SlipstreamZapRouter" \
  000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef000000000000000000000000be6d8f0d05cc4be24d5167a3ef062215be6d18a50000000000000000000000004200000000000000000000000000000000000006
verify 0x24dc2a849D3dbD93d8051d6C8d3215Be718B6Dd8 TimelockController.standard-input.json "lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController" \
  0000000000000000000000000000000000000000000000000000000000015180000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000002000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000000
# Notus's LaunchToken: name "Notus", symbol "NOTUS", 1e27 supply, not transferable, the pad
verify 0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF LaunchToken.standard-input.json "src/LaunchToken.sol:LaunchToken" \
  00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000033b2e3c9fd0803ce80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef00000000000000000000000000000000000000000000000000000000000000054e6f74757300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000054e4f545553000000000000000000000000000000000000000000000000000000
echo "== done: https://basescan.org/address/0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF#code"
