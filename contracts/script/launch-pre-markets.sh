#!/bin/bash
# Launch the Notus Pre-Market tokens (synthetic pre-IPO price discovery) as
# regular ETH-curve launches from YOUR wallet — creator fees accrue to you.
# Each is a plain Notus launch token: once one GRADUATES (800M sold, ~4 ETH),
# whitelist it as a quote asset with enable-pre-markets.sh so creators can
# pair new tokens with it. Do NOT whitelist before graduation: pre-graduation
# transfer locks would block the paired tokens' own Uniswap migration.
#
# Optional dev buy: append  --value 0.05ether  to any cast send below.
set -e
cd "$(dirname "$0")/.." && source .env
PAD=${LAUNCHPAD:-0xDE295591af5A8c950fB5Edf564B82a4b0A5f2B04}
RPC=https://rpc.mainnet.chain.robinhood.com
SIG='createToken(string,string,uint256,(string,string,string,string,string,string),address,bool)'
DISCLAIMER="Synthetic community pre-market: price discovery only. No equity, no backing, no affiliation with the company."
ZERO=0x0000000000000000000000000000000000000000

# Fee mode: true = the whole 80% fee pot is holder cashback ("hold the
# pre-market, earn the fees" — the treasury 20% and the graduation LP fees
# still accrue to the platform/creator). Set to false to keep fees instead.
REWARDS=true

launch() { # name symbol description
  echo "launching $2 ($1)..."
  cast send "$PAD" "$SIG" "$1" "$2" 0 "(\"\",\"\",\"\",\"\",\"\",\"$3\")" $ZERO $REWARDS \
    --rpc-url $RPC --private-key "$PRIVATE_KEY"
}

launch "OpenAI Pre-Market"    "OPENAI" "OpenAI pre-IPO community market. $DISCLAIMER"
launch "Anthropic Pre-Market" "ANTHRO" "Anthropic pre-IPO community market. $DISCLAIMER"
launch "xAI Pre-Market"       "XAI"    "xAI pre-IPO community market. $DISCLAIMER"
launch "Stripe Pre-Market"    "STRIPE" "Stripe pre-IPO community market. $DISCLAIMER"

echo "done — 4 pre-markets live on their ETH curves"
