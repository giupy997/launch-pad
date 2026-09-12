#!/bin/bash
# Whitelist a GRADUATED Notus Pre-Market token as a quote asset (owner only).
# Usage:  ./enable-pre-markets.sh <token-address> [virtual-reserve-tokens]
#
# ONLY run this after the pre-market token has graduated — before graduation
# its transfer lock would block the paired tokens' Uniswap migration.
#
# Virtual reserve sizing (same convention as the stocks: ~$14k curve raise,
# raise = 3.2 x virtual, so virtual is ~$4,400 worth of the pre-market token):
#   virtual_tokens = 4400 / token_price_usd
# Right after graduation the curve's end price is ~5.25 ETH / 250M tokens
# (~$5.4e-5 at ETH $2,570), which gives ~80M tokens — the default below.
# If the pool price has moved since graduation, recompute and pass it.
#
# After it confirms, add the token to QUOTE_ASSETS in web/lib/config.ts with
#   preIpo: true, zapFees: [10000]
# (the graduation pool IS the 1% WETH pool, so ETH zap buys work in one hop).
set -e
cd "$(dirname "$0")/.." && source .env
PAD=${LAUNCHPAD:-0xD5d932C0A1418Bc0976D1a2D733F8e363746A4bC}
RPC=https://rpc.mainnet.chain.robinhood.com

TOKEN=${1:?usage: enable-pre-markets.sh <token-address> [virtual-reserve-tokens]}
VIRTUAL_TOKENS=${2:-80000000} # ~$4,400 at the fresh-graduation price

echo "enabling $TOKEN as quote asset (virtual $VIRTUAL_TOKENS tokens)..."
cast send "$PAD" 'setQuoteAsset(address,uint256)' "$TOKEN" "${VIRTUAL_TOKENS}000000000000000000" \
  --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "done — now add it to QUOTE_ASSETS in web/lib/config.ts (preIpo: true, zapFees: [10000])"
