#!/bin/bash
# Verify the Base v9 stack on Basescan (Etherscan's Base explorer), which keeps
# its own database apart from Blockscout's and Sourcify's. Needs an Etherscan
# API key (free, etherscan.io → My API Keys; one key serves every chain on
# their v2 API) in contracts/.env as ETHERSCAN_API_KEY — never in a chat or a
# commit — and a foundry recent enough for that v2 API (`foundryup` if forge
# complains about v1).
#
#   cd ~/launch-pad/contracts && bash verify/base-v9/verify-basescan.sh
#   FORCE=1 bash verify/base-v9/verify-basescan.sh      # when forge wrongly says "already verified"
#
# The LaunchToken of every coin is created by the factory and shares its
# runtime bytecode with Notus's (the immutables are the pad and the
# transferable flag, the same for every coin of this pad), so once Notus's is
# verified Basescan shows every other coin's source as a "similar match".
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.foundry/bin:$PATH"
if [ -z "${ETHERSCAN_API_KEY:-}" ] && [ -f .env ]; then set -a; source .env; set +a; fi
: "${ETHERSCAN_API_KEY:?ETHERSCAN_API_KEY is not set: add it to contracts/.env}"
CHAIN=8453
PAD=0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF
ETHERSCAN_V2=${ETHERSCAN_V2:-https://api.etherscan.io/v2/api}
# FORCE=1: submit even when forge believes the explorer already has the source
# (its check reads the API, which can answer for a "similar match" or a stale entry)
SKIP=${FORCE:+--skip-is-verified-check}

verify() {  # address  contract  [constructor args hex]
  echo "== $2 at $1"
  # the explicit URL matters: foundry.toml's [etherscan] entry for chain 8453 is Blockscout's API, which
  # already holds these verifications and would answer "already verified" (or throttle) for Basescan's sake
  forge verify-contract --chain $CHAIN --verifier etherscan --verifier-url "$ETHERSCAN_V2" --etherscan-api-key "$ETHERSCAN_API_KEY" --watch $SKIP \
    ${3:+--constructor-args "$3"} "$1" "$2" 2>&1 | grep -E "Submitted|Response|Status|verified|already|Error|rror|GUID|Pass|Fail" || true
}

verify $PAD src/Launchpad.sol:Launchpad 0x00000000000000000000000024622320d93da2d9c626ee469ad0c2c48a1ed7f7
verify 0x0287eD7e89b1D7B69Db08B16020341151E93F530 src/LaunchTokenFactory.sol:LaunchTokenFactory
verify 0x92329D494D4D098C95A87E381a4D60CA666edb1b src/UniV2Migrator.sol:UniV2Migrator 0x000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef0000000000000000000000004752ba5dbc23f44d87826276bf6fd6b1c372ad24
verify 0x2C3861638055A82782B8d30471c153B2DA00e756 src/SlipstreamZapRouter.sol:SlipstreamZapRouter 0x000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef000000000000000000000000be6d8f0d05cc4be24d5167a3ef062215be6d18a50000000000000000000000004200000000000000000000000000000000000006
verify 0x24dc2a849D3dbD93d8051d6C8d3215Be718B6Dd8 lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController 0x0000000000000000000000000000000000000000000000000000000000015180000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000002000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000000
# Notus's LaunchToken: name "Notus", symbol "NOTUS", 1e27 supply, not transferable, the pad
verify 0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF src/LaunchToken.sol:LaunchToken 0x00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000033b2e3c9fd0803ce80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef00000000000000000000000000000000000000000000000000000000000000054e6f74757300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000054e4f545553000000000000000000000000000000000000000000000000000000
echo "== done: https://basescan.org/address/$PAD#code"
