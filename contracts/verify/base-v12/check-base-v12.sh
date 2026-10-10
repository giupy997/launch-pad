#!/bin/bash
# The deployed v12 stack on Base, read back and compared with what it must
# be: who owns the pad, its fee, its treasury, its migrator, module and
# factory, cbLTC the only quote at 50 cbLTC of virtual reserve, no migration
# operator, no freeze; the migrator's and the zap's pad; the timelock's delay
# and roles (the proposer schedules and cancels, anyone executes, nobody
# administers). Every line PASS, or the one that is not says what it found.
#
#   cd ~/launch-pad/contracts && bash verify/base-v12/check-base-v12.sh      # node: BASE_RPC, else SRC_RPC's first, else foundry's `base`
#
# Read-only: no signer, no gas. The addresses come from addresses.sh, read
# after .env so that a TREASURY (or any other name) in .env never replaces
# the recorded deployment the chain is compared with.
set -uo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -f .env ]; then set -a; source .env; set +a; fi
# shellcheck disable=SC1091
source verify/base-v12/addresses.sh
RPC=${BASE_RPC:-${SRC_RPC:-}}
RPC=${RPC%%,*}
RPC=${RPC:-base}
CBLTC=0xcb17C9Db87B595717C857a08468793f5bAb6445F
UNIV2_ROUTER=0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
SLIPSTREAM_ROUTER=0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5
ZERO=0x0000000000000000000000000000000000000000
FAILS=0

lower() { echo "$1" | tr 'A-F' 'a-f'; }
call() { cast call "$1" "$2" "${@:3}" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}'; }
# expect LABEL GOT WANT: addresses compared case-blind, numbers as printed
expect() {
  local got want
  got=$(lower "$2"); want=$(lower "$3")
  if [ "$got" = "$want" ]; then printf 'PASS  %-38s %s\n' "$1" "$2"
  else printf 'FAIL  %-38s got %s, want %s\n' "$1" "$got" "$want"; FAILS=$((FAILS + 1)); fi
}
deployed() {  # LABEL ADDRESS: code at the address
  local size
  size=$(cast code "$2" --rpc-url "$RPC" 2>/dev/null | wc -c)
  if [ "$size" -gt 4 ]; then printf 'PASS  %-38s %s (%d bytes of code)\n' "$1" "$2" $(( (size - 3) / 2 ))
  else printf 'FAIL  %-38s no code at %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); fi
}

# the node's host alone: a keyed URL (Alchemy) must never reach a terminal that gets pasted
host() { case "$1" in http*) node -e 'console.log(new URL(process.argv[1]).host)' "$1" 2>/dev/null || echo "$1" ;; *) echo "$1" ;; esac; }
echo "Base v12 stack through $(host "$RPC") · block $(cast block-number --rpc-url "$RPC")"
echo "== code"
deployed "Launchpad" "$PAD"
deployed "LaunchpadMigration (module)" "$MODULE"
deployed "LaunchTokenFactory" "$FACTORY"
deployed "UniV2Migrator" "$MIGRATOR"
deployed "SlipstreamZapRouter" "$ZAP"
deployed "TimelockController" "$TIMELOCK"

echo "== the pad"
expect "owner = timelock" "$(call "$PAD" 'owner()(address)')" "$TIMELOCK"
expect "feeBps = 50 (0.5% a side)" "$(call "$PAD" 'feeBps()(uint256)')" 50
expect "treasury" "$(call "$PAD" 'treasury()(address)')" "$TREASURY"
expect "migrator" "$(call "$PAD" 'migrator()(address)')" "$MIGRATOR"
expect "MIGRATION_MODULE" "$(call "$PAD" 'MIGRATION_MODULE()(address)')" "$MODULE"
expect "tokenFactory" "$(call "$PAD" 'tokenFactory()(address)')" "$FACTORY"
expect "cbLTC virtual reserve = 50 cbLTC" "$(call "$PAD" 'quoteVirtualReserve(address)(uint256)' "$CBLTC")" 5000000000
expect "native quote off" "$(call "$PAD" 'quoteVirtualReserve(address)(uint256)' "$ZERO")" 0
expect "migrationOperator = none" "$(call "$PAD" 'migrationOperator()(address)')" "$ZERO"
expect "freezeBlock = 0 (no freeze)" "$(call "$PAD" 'freezeBlock()(uint256)')" 0
expect "migrationClosed = false" "$(call "$PAD" 'migrationClosed()(bool)')" false
echo "      coins on the pad: $(call "$PAD" 'tokenCount()(uint256)')"

echo "== the migrator and the zap"
expect "migrator.launchpad" "$(call "$MIGRATOR" 'launchpad()(address)')" "$PAD"
expect "migrator.router = Uniswap v2 Router02" "$(call "$MIGRATOR" 'router()(address)')" "$UNIV2_ROUTER"
expect "zap.launchpad" "$(call "$ZAP" 'launchpad()(address)')" "$PAD"
expect "zap.swapRouter = Slipstream" "$(call "$ZAP" 'swapRouter()(address)')" "$SLIPSTREAM_ROUTER"

echo "== the timelock"
PROPOSER_ROLE=$(cast keccak "PROPOSER_ROLE")
EXECUTOR_ROLE=$(cast keccak "EXECUTOR_ROLE")
CANCELLER_ROLE=$(cast keccak "CANCELLER_ROLE")
ADMIN_ROLE=0x0000000000000000000000000000000000000000000000000000000000000000
expect "minDelay = $DELAY s" "$(call "$TIMELOCK" 'getMinDelay()(uint256)')" "$DELAY"
expect "proposer may propose" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$PROPOSER_ROLE" "$PROPOSER")" true
expect "proposer may cancel" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$CANCELLER_ROLE" "$PROPOSER")" true
expect "anyone may execute (open role)" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$EXECUTOR_ROLE" "$ZERO")" true
expect "proposer is not admin" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$ADMIN_ROLE" "$PROPOSER")" false
expect "timelock is its own admin" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$ADMIN_ROLE" "$TIMELOCK")" true
expect "forge's stand-in sender is no proposer" "$(call "$TIMELOCK" 'hasRole(bytes32,address)(bool)' "$PROPOSER_ROLE" 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38)" false

echo "== balances the pad should not be sitting on"
echo "      pad's cbLTC: $(call "$CBLTC" 'balanceOf(address)(uint256)' "$PAD") satoshis (the curves' reserves and pots of its coins; 0 while it has none)"
echo "      migrator's cbLTC: $(call "$CBLTC" 'balanceOf(address)(uint256)' "$MIGRATOR") satoshis (must stay 0: nothing is meant to rest there)"
echo "      migrator's ETH: $(cast balance "$MIGRATOR" --rpc-url "$RPC" 2>/dev/null) wei (must stay 0)"

echo
if [ "$FAILS" = 0 ]; then echo "ALL PASS: the v12 stack on Base is configured as deployed"; else echo "$FAILS check(s) FAILED"; exit 1; fi
