#!/bin/bash
# Verify the Liteforge v11 rehearsal pad and its migrator on the Caldera
# Blockscout (liteforge.explorer.caldera.xyz) through Blockscout's own v2 API,
# with the Standard JSON inputs in this folder: forge's Etherscan-style
# verifier got "Something went wrong" from the same explorer right after the
# deploy. Pass FIRST_TOKEN (and FIRST_NAME, FIRST_SYMBOL) to verify the first
# coin's LaunchToken as well.
#
#   cd ~/launch-pad/contracts && bash verify/liteforge-v11/verify-blockscout.sh
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.foundry/bin:$PATH"
API=https://liteforge.explorer.caldera.xyz/api/v2/smart-contracts
COMPILER="v0.8.24+commit.e11b9ed9"
PAD=0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F
MIGRATOR=0xD45e4011Dae718aAF95DB5BdCA8e7Ee3ca8F413F
TREASURY=0x707f56C25e5d8cc12d08A3bf73f54dBeD0CD9A02
ROUTER=0xD56a623890b083d876D47c3b1c5343b7f983FA62

RPC=https://liteforge.rpc.caldera.xyz/infra-partner-http
DEPLOY_BLOCK=57741789

verified() { curl -sS -m 20 "$API/$1" | grep -q '"is_verified":true'; }

# one field of a JSON answer on stdin, by dotted path ("items.0.height")
json() {
  node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?undefined:o[k],j);console.log(v==null?"":typeof v==="string"?v:JSON.stringify(v))}catch{console.log("")}})' "$1"
}

# how far the explorer has read, against the chain: a contract it has not
# indexed yet is "not a smart-contract" to it, and verification must wait
head=$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo "?")
seen=$(curl -sS -m 20 "https://liteforge.explorer.caldera.xyz/api/v2/blocks?type=block" | json items.0.height)
echo "chain head $head · the explorer's latest block ${seen:-?} · the pad was deployed at $DEPLOY_BLOCK"
for a in "$PAD" "$MIGRATOR"; do
  code=$(cast code "$a" --rpc-url "$RPC" 2>/dev/null | head -c 12)
  isc=$(curl -sS -m 20 "https://liteforge.explorer.caldera.xyz/api/v2/addresses/$a" | json is_contract)
  echo "   $a: on chain $([ "$code" != "0x" ] && [ -n "$code" ] && echo "a contract" || echo "NO CODE") · to the explorer: ${isc:-unknown}"
done
if [ -n "$seen" ] && [ "$seen" != "?" ] && [ "$seen" -lt "$DEPLOY_BLOCK" ] 2>/dev/null; then
  echo "the explorer has not reached the deploy block yet: rerun once it has"
  exit 0
fi

verify() {  # address  file  "path:Name"  constructor args (0x…)
  local addr=$1 file=$2 name=$3 args=$4
  if verified "$addr"; then echo "== $name at $addr: already verified"; return; fi
  echo "== $name at $addr"
  curl -sS -m 90 -X POST "$API/$addr/verification/via/standard-input" \
    -F "compiler_version=$COMPILER" \
    -F "license_type=mit" \
    -F "contract_name=$name" \
    -F "autodetect_constructor_args=false" \
    -F "constructor_args=$args" \
    -F "files[0]=@$file;type=application/json"
  echo
  for _ in $(seq 1 18); do
    sleep 5
    if verified "$addr"; then echo "   verified"; return; fi
  done
  echo "   still pending: https://liteforge.explorer.caldera.xyz/address/$addr?tab=contract"
}

verify "$PAD" Launchpad.standard-input.json "src/Launchpad.sol:Launchpad" "$(cast abi-encode 'constructor(address)' "$TREASURY")"
verify "$MIGRATOR" UniV2Migrator.standard-input.json "src/UniV2Migrator.sol:UniV2Migrator" "$(cast abi-encode 'constructor(address,address)' "$PAD" "$ROUTER")"
if [ -n "${FIRST_TOKEN:-}" ]; then
  verify "$FIRST_TOKEN" LaunchToken.standard-input.json "src/LaunchToken.sol:LaunchToken" \
    "$(cast abi-encode 'constructor(string,string,uint256,bool,address)' "$FIRST_NAME" "$FIRST_SYMBOL" 1000000000000000000000000000 false "$PAD")"
fi
echo "== done"
