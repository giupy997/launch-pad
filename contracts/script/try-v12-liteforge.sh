#!/bin/bash
# v12 for real, end to end, on the Liteforge testnet: a fresh v12 pad on
# Lester Labs' Uniswap v2 (DeployLitVM), a taxed coin created on it, bought
# through graduation in one buy (the pad refunds the surplus), then a buy and
# a sell on its real pool, a harvest and a wallet transfer with every fee
# figure checked (RehearseV12Pool). Everything signed by the deployer.
#
#   cd ~/launch-pad/contracts && bash script/try-v12-liteforge.sh      # reads .env itself
#
# Needs foundry, the deployer's signer (the keystore ACCOUNT, default `notus`,
# asking its password at each signature; or PRIVATE_KEY for a test key) and
# about 2 zkLTC on Liteforge: ~0.2 of gas for the stack, 1.65 for the
# graduating buy (NATIVE_VIRTUAL 0.5 zkLTC: a curve raises 1.6), 0.01 for
# the pool buy. Variables, all optional: PAD (a v12 pad to reuse, with
# MIGRATOR), NATIVE_VIRTUAL (wei), NAME, SYMBOL, DST_RPC, POOL_QUOTE_IN.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then
  KEY_GIVEN=${PRIVATE_KEY:-}
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  if [ -n "$KEY_GIVEN" ]; then PRIVATE_KEY=$KEY_GIVEN; fi
  unset KEY_GIVEN
fi
PWFILE=
trap 'rm -f "${PWFILE:-}"' EXIT
if [ -n "${PRIVATE_KEY:-}" ]; then
  SIGNER=(--private-key "$PRIVATE_KEY")
else
  [ -t 0 ] || { echo "the keystore password is asked at a terminal: run this from one (or set PRIVATE_KEY for a test key)"; exit 1; }
  read -rsp "password of the keystore ${ACCOUNT:-notus}: " KEYSTORE_PASSWORD; echo
  PWFILE=$(mktemp /dev/shm/notus-keystore.XXXXXX)
  printf '%s' "$KEYSTORE_PASSWORD" > "$PWFILE"
  unset KEYSTORE_PASSWORD
  SIGNER=(--account "${ACCOUNT:-notus}" --password-file "$PWFILE")
fi
DST_RPC=${DST_RPC:-https://liteforge.rpc.caldera.xyz/infra-partner-http}
# the v7.7 pad's migrator on Liteforge: it knows the DEX router there
OLD_MIGRATOR=0xE34b882BD48D3b13A92C5A7C99469485d1761776
NATIVE_VIRTUAL=${NATIVE_VIRTUAL:-500000000000000000}
NAME=${NAME:-"V12 Trial"}
SYMBOL=${SYMBOL:-TRIAL}
ZERO=0x0000000000000000000000000000000000000000
MIG=../litecoin/migration
mkdir -p "$MIG"
DEPLOYER=$(cast wallet address "${SIGNER[@]}")
echo "deployer $DEPLOYER · $(cast balance "$DEPLOYER" --rpc-url "$DST_RPC" --ether) zkLTC on Liteforge"

echo "== 0. build"
forge build --silent

echo "== 1. the v12 pad on Liteforge (native zkLTC, $NATIVE_VIRTUAL wei of virtual reserve)"
if [ -z "${PAD:-}" ]; then
  ROUTER=$(cast call $OLD_MIGRATOR "router()(address)" --rpc-url "$DST_RPC")
  echo "   DEX router (Lester Labs' Uniswap v2): $ROUTER"
  OUT=$(UNIV2_ROUTER=$ROUTER NATIVE_VIRTUAL=$NATIVE_VIRTUAL TREASURY=$DEPLOYER forge script script/DeployLitVM.s.sol --rpc-url "$DST_RPC" "${SIGNER[@]}" --broadcast 2>&1) \
    || { echo "the deploy failed:"; echo "$OUT" | tail -20; exit 1; }
  echo "$OUT" | grep -E "Launchpad:|LaunchpadMigration:|UniV2Migrator:|Fee \(bps\)|Deploy block:|Error|revert|Reason" || true
  PAD=$(echo "$OUT" | awk '/^  Launchpad:/ {print $2}' | tail -1)
  MIGRATOR=$(echo "$OUT" | awk '/UniV2Migrator:/ {print $2}' | tail -1)
  [ -n "$PAD" ] && [ -n "$MIGRATOR" ] || { echo "no addresses in the deploy output"; echo "$OUT" | tail -20; exit 1; }
else
  MIGRATOR=${MIGRATOR:-$(cast call "$PAD" "migrator()(address)" --rpc-url "$DST_RPC")}
fi
printf '{"launchpad":"%s","migrator":"%s","quote":"%s"}\n' "$PAD" "$MIGRATOR" "$ZERO" > "$MIG/rehearsal-target.json"
echo "   pad $PAD · migrator $MIGRATOR"

echo "== 2. a coin with a tax: $NAME ($SYMBOL), 1% buy / 1% sell, 70% creator / 30% liquidity"
cast send "$PAD" \
  "createTokenWithFees(string,string,uint256,(string,string,string,string,string,string),address,(uint16,uint16,uint16,uint16,uint16,uint16,uint16))" \
  "$NAME" "$SYMBOL" 0 '("","","","","","")' "$ZERO" "(100,100,7000,0,0,3000,0)" \
  --rpc-url "$DST_RPC" "${SIGNER[@]}" >/dev/null
COUNT=$(cast call "$PAD" "tokenCount()(uint256)" --rpc-url "$DST_RPC")
TOKEN=$(cast call "$PAD" "allTokens(uint256)(address)" $((COUNT - 1)) --rpc-url "$DST_RPC")
echo "   token $TOKEN"

echo "== 3. bought through graduation in one buy (the surplus comes back)"
# the curve raises 3.2 times its virtual reserve; the buy pays 0.5% + 1% on top; a little more, refunded
BUY=$(node -e 'const v=BigInt(process.argv[1]); console.log((v*32n/10n*10000n/9850n*103n/100n).toString())' "$NATIVE_VIRTUAL")
cast send "$PAD" "buy(address,uint256)" "$TOKEN" 0 --value "$BUY" --rpc-url "$DST_RPC" "${SIGNER[@]}" >/dev/null
GRAD=$(cast call "$TOKEN" "graduated()(bool)" --rpc-url "$DST_RPC")
[ "$GRAD" = true ] || { echo "   not graduated after the buy: is NATIVE_VIRTUAL the pad's?"; exit 1; }
PAIR=$(cast call "$MIGRATOR" "pairOf(address)(address)" "$TOKEN" --rpc-url "$DST_RPC")
echo "   graduated · pool $PAIR · registered for the fee: $(cast call "$PAD" "taxedPool(address,address)(bool)" "$TOKEN" "$PAIR" --rpc-url "$DST_RPC")"

echo "== 4. the pool: a buy, a sell, a harvest, a transfer, the fees checked"
OUT=$(TOKEN=$TOKEN SINGLE_SIGNER=true QUOTE_IN=${POOL_QUOTE_IN:-10000000000000000} forge script script/rehearsal/RehearseV12Pool.s.sol --rpc-url "$DST_RPC" "${SIGNER[@]}" --broadcast 2>&1) \
  || { echo "the pool trial failed:"; echo "$OUT" | grep -E "PASS|Error|revert|Reason" || echo "$OUT" | tail -30; exit 1; }
echo "$OUT" | grep -E "^  [a-z]|PASS|Error|revert|Reason" || true

echo "== done"
echo "   pad        $PAD   https://liteforge.explorer.caldera.xyz/address/$PAD"
echo "   migrator   $MIGRATOR"
echo "   coin       $TOKEN   https://liteforge.explorer.caldera.xyz/address/$TOKEN"
echo "   pool       $PAIR"
echo "   treasury   $DEPLOYER (the deployer: the launchpad's 0.5% and the harvest's part landed here)"
echo "   buckets    $(cast call "$PAD" "taxTreasury(address)(uint256)" "$TOKEN" --rpc-url "$DST_RPC") / $(cast call "$PAD" "taxPot(address)(uint256)" "$TOKEN" --rpc-url "$DST_RPC") coins still waiting (next harvest: anyone, next block)"
