#!/bin/bash
# Enable the official Robinhood tokenized stocks as quote assets (owner only).
# Virtual reserves target a ~$14k curve raise per asset (raise = 3.2 x virtual);
# tune the numbers below if stock prices have moved a lot.
set -e
cd "$(dirname "$0")/.." && source .env
PAD=${LAUNCHPAD:-0xD5d932C0A1418Bc0976D1a2D733F8e363746A4bC}
RPC=https://rpc.mainnet.chain.robinhood.com
echo "enabling NVDA (virtual 24 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 24000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling AAPL (virtual 18 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 18000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling TSLA (virtual 11 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0x322F0929c4625eD5bAd873c95208D54E1c003b2d 11000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling GME (virtual 160 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0x1b0E319c6A659F002271B69dB8A7df2F911c153E 160000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling MSFT (virtual 10 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0xe93237C50D904957Cf27E7B1133b510C669c2e74 10000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling AMZN (virtual 20 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0x12f190a9F9d7D37a250758b26824B97CE941bF54 20000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling META (virtual 7 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35 7000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling GOOGL (virtual 23 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3 23000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling COIN (virtual 15 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0x6330D8C3178a418788dF01a47479c0ce7CCF450b 15000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling PLTR (virtual 60 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A 60000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "enabling AMD (virtual 33 shares)..."
cast send $PAD 'setQuoteAsset(address,uint256)' 0x86923f96303D656E4aa86D9d42D1e57ad2023fdC 33000000000000000000 --rpc-url $RPC --private-key "$PRIVATE_KEY"
echo "done — all 11 stock quote assets enabled"
