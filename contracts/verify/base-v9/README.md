# Verifying the Base v9 stack on Blockscout, by hand

Deployed on Base (chain 8453) at block 52,009,454 from commit `cd6db6b`.
On each contract's page at https://base.blockscout.com → *Verify & publish* →
**Solidity (Standard JSON input)**: compiler `v0.8.24+commit.e11b9ed9`,
EVM version `cancun` (as the JSON says), upload the file named below, paste the
constructor arguments (ABI-encoded, without the 0x if the form says so).

| Contract | Address | File | Constructor arguments |
|---|---|---|---|
| Launchpad | `0x0ba4dD0782e10a1D3946531dACC12F3797b74955` | `Launchpad.standard-input.json` | `0x00000000000000000000000024622320d93da2d9c626ee469ad0c2c48a1ed7f7` |
| LaunchTokenFactory | `0xfD4247bad67347E56B1307b35eB28ca443482234` | `LaunchTokenFactory.standard-input.json` | none (created by the Launchpad's constructor) |
| UniV2Migrator | `0x4D3C63F873bc2aC79E529C8003321d60643a4025` | `UniV2Migrator.standard-input.json` | `0x0000000000000000000000000ba4dd0782e10a1d3946531dacc12f3797b749550000000000000000000000004752ba5dbc23f44d87826276bf6fd6b1c372ad24` |
| SlipstreamZapRouter | `0xd7404Fe1aA4aAB4d27D1843c46e0b8cadA333C55` | `SlipstreamZapRouter.standard-input.json` | `0x0000000000000000000000000ba4dd0782e10a1d3946531dacc12f3797b74955000000000000000000000000be6d8f0d05cc4be24d5167a3ef062215be6d18a50000000000000000000000004200000000000000000000000000000000000006` |
| TimelockController | `0xb97a4A1e998198bE8926a316361a4F3720f7d92c` | `TimelockController.standard-input.json` | `0x0000000000000000000000000000000000000000000000000000000000015180000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000002000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000000` |

The LaunchToken of every coin is created by the factory: verify the first one
once with `LaunchToken` (arguments: name, symbol, 1000000000e18, false, the
Launchpad) and Blockscout matches the rest by bytecode.

Links: https://base.blockscout.com/address/0x0ba4dD0782e10a1D3946531dACC12F3797b74955?tab=contract ·
https://base.blockscout.com/address/0xfD4247bad67347E56B1307b35eB28ca443482234?tab=contract ·
https://base.blockscout.com/address/0x4D3C63F873bc2aC79E529C8003321d60643a4025?tab=contract ·
https://base.blockscout.com/address/0xd7404Fe1aA4aAB4d27D1843c46e0b8cadA333C55?tab=contract ·
https://base.blockscout.com/address/0xb97a4A1e998198bE8926a316361a4F3720f7d92c?tab=contract
