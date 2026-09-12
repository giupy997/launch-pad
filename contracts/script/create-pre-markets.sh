#!/bin/bash
# Create the Notus Pre-Markets (owner only, v7.3+): each call deploys a
# synthetic pre-IPO asset that is
#   - transferable from day one,
#   - in holders-rewards fee mode (80% of its trade fees -> its holders),
#   - IMMEDIATELY whitelisted as a quote asset (shows up next to the stocks
#     in the create picker; the ETH curve-zap works from block one).
# The virtual reserve (last arg) sizes curves PAIRED with the pre-market, in
# pre-market units: 50M at launch ~ a sensible raise that scales with the
# pre-market's own price. Retune later with setQuoteAsset as price discovers.
#
# Also whitelists SPCX — Robinhood's official SpaceX pre-IPO token — as a
# quote asset (30 virtual shares ~ $4.4k at ~$148/share).
set -e
cd "$(dirname "$0")/.." && source .env
PAD=${LAUNCHPAD:?set LAUNCHPAD to the v7.3 launchpad address}
RPC=https://rpc.mainnet.chain.robinhood.com
SIG='createPreMarket(string,string,(string,string,string,string,string,string),uint256)'
DISCLAIMER="Synthetic community pre-market: price discovery only. No equity, no backing, no affiliation with the company."
VIRTUAL=50000000000000000000000000 # 50M tokens

create() { # name symbol description
  echo "creating pre-market $2 ($1)..."
  cast send "$PAD" "$SIG" "$1" "$2" "(\"\",\"\",\"\",\"\",\"\",\"$3\")" $VIRTUAL \
    --rpc-url $RPC --private-key "$PRIVATE_KEY"
}

create "OpenAI Pre-Market"    "OPENAI" "OpenAI pre-IPO community market. $DISCLAIMER"
create "Anthropic Pre-Market" "ANTHRO" "Anthropic pre-IPO community market. $DISCLAIMER"
create "xAI Pre-Market"       "XAI"    "xAI pre-IPO community market. $DISCLAIMER"
create "Stripe Pre-Market"    "STRIPE" "Stripe pre-IPO community market. $DISCLAIMER"

echo "whitelisting SPCX (official Robinhood SpaceX token, virtual 30 shares)..."
cast send "$PAD" 'setQuoteAsset(address,uint256)' 0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa 30000000000000000000 \
  --rpc-url $RPC --private-key "$PRIVATE_KEY"

echo "done — 4 pre-markets live as pair assets + SPCX whitelisted"
