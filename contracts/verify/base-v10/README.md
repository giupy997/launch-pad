# Base v10 stack: verification

The Standard JSON inputs of the v10 contracts (`node script/standard-input.mjs`
from the commit that deployed them) and a script that submits them to Basescan
through Etherscan's v2 API, `verify-basescan.sh`, which reads the deployed
addresses from `addresses.sh` (filled from the deploy script's output). Needs `ETHERSCAN_API_KEY` in `contracts/.env`.
Blockscout (base.blockscout.com) takes the same files by hand under
Verify & publish → Solidity (Standard JSON input), compiler v0.8.24.

All five contracts read "Pass - Verified" on Basescan on 2026-10-04 (the factory, the
zap and the timelock were matched to earlier verified bytecode on submission).
