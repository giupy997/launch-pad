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

The inputs here for LaunchTokenFactory, LaunchpadMigration, UniV2Migrator,
SlipstreamZapRouter and TimelockController are the ones Basescan accepted on
2026-10-09. The Launchpad's (and the LaunchToken's) must come from the build
that deployed — forge 1.8.3 on the VPS: a forge 1.5.1 build of the same
sources gives another creation bytecode (the contract embeds the factory's
and the module's creation code with their metadata) and Basescan refused it.
Regenerate them there before verifying:

    cd ~/launch-pad/contracts && node script/standard-input.mjs src/Launchpad.sol:Launchpad src/LaunchToken.sol:LaunchToken \
      && cp out/verify/Launchpad.standard-input.json out/verify/LaunchToken.standard-input.json verify/base-v12/

