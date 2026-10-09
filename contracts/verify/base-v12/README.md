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

`check-base-v12.sh` reads the deployed stack back (read-only, no signer) and
compares it with what it must be: the pad's owner, fee, treasury, migrator,
module, factory and quote, the migrator's and the zap's pad and routers, the
timelock's delay and roles. Every line PASS, or it exits 1 naming the one
that is not:

    cd ~/launch-pad/contracts && bash verify/base-v12/check-base-v12.sh

The inputs here come from the build that deployed: forge 1.8.3, the deployer's
checkout on the VPS (`~/launch-pad/contracts`, absolute path included). Both
matter: forge writes the remappings into the metadata, and 1.8.3 adds context
remappings with the project's absolute path, so the same sources built elsewhere, or with
another forge, give another metadata hash — and another creation bytecode
for the Launchpad, which embeds the module's and the factory's creation code
with their metadata. Basescan refused a forge 1.5.1 build of it on
2026-10-09; the inputs here reproduce the deployed bytecode exactly
(`solc --standard-json` on `Launchpad.standard-input.json` gives the creation
code `forge inspect` prints on the VPS, md5 `36d1ff18be2507cae2e5d213b8c5f503`).
To regenerate them, on the VPS:

    cd ~/launch-pad/contracts && forge build && node script/standard-input.mjs src/Launchpad.sol:Launchpad \
      src/LaunchpadMigration.sol:LaunchpadMigration src/LaunchTokenFactory.sol:LaunchTokenFactory src/LaunchToken.sol:LaunchToken \
      src/UniV2Migrator.sol:UniV2Migrator src/SlipstreamZapRouter.sol:SlipstreamZapRouter \
      lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController \
      && cp out/verify/*.standard-input.json verify/base-v12/
