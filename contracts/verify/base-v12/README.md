# Base v12 stack: verification

The Standard JSON inputs of the v12 contracts (`node script/standard-input.mjs`
from the commit that deployed them: Launchpad, LaunchpadMigration — the
migration module the pad's constructor deployed, no constructor arguments —,
LaunchTokenFactory, LaunchToken, UniV2Migrator v3, SlipstreamZapRouter,
TimelockController) and `verify-basescan.sh`, which submits them to Basescan
through Etherscan's v2 API, reading the deployed addresses from `addresses.sh`.
Needs `ETHERSCAN_API_KEY` in `contracts/.env`. Blockscout (base.blockscout.com)
takes the same files by hand under Verify & publish → Solidity (Standard JSON
input), compiler v0.8.24. Set `FIRST_TOKEN` in `addresses.sh` once the first
coin exists to verify its LaunchToken (the others show as similar matches).
