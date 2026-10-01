# Verifying the Base v9 stack on Blockscout, by hand

**Done on 2026-10-01**: every contract below is verified on base.blockscout.com; the
LaunchToken through Sourcify (`forge verify-contract --verifier sourcify`), which
Blockscout imports, after the public API's rate limit refused the direct route.
Kept for the next deployment.

Deployed on Base (chain 8453) at block 52,045,689 from the sources at commit
`771546c` (the contracts are those of `cd6db6b`, unchanged since). On each
contract's page at https://base.blockscout.com → *Verify & publish* →
**Solidity (Standard JSON input)**: compiler `v0.8.24+commit.e11b9ed9`, EVM
version `cancun` (as the JSON says), upload the file named below, paste the
constructor arguments (ABI-encoded, without the 0x if the form says so).

| Contract | Address | File | Constructor arguments |
|---|---|---|---|
| Launchpad | `0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF` | `Launchpad.standard-input.json` | `0x00000000000000000000000024622320d93da2d9c626ee469ad0c2c48a1ed7f7` |
| LaunchTokenFactory | `0x0287eD7e89b1D7B69Db08B16020341151E93F530` | `LaunchTokenFactory.standard-input.json` | none (created by the Launchpad's constructor) |
| UniV2Migrator | `0x92329D494D4D098C95A87E381a4D60CA666edb1b` | `UniV2Migrator.standard-input.json` | `0x000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef0000000000000000000000004752ba5dbc23f44d87826276bf6fd6b1c372ad24` |
| SlipstreamZapRouter | `0x2C3861638055A82782B8d30471c153B2DA00e756` | `SlipstreamZapRouter.standard-input.json` | `0x000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef000000000000000000000000be6d8f0d05cc4be24d5167a3ef062215be6d18a50000000000000000000000004200000000000000000000000000000000000006` |
| TimelockController | `0x24dc2a849D3dbD93d8051d6C8d3215Be718B6Dd8` | `TimelockController.standard-input.json` | `0x0000000000000000000000000000000000000000000000000000000000015180000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000002000000000000000000000000707f56c25e5d8cc12d08a3bf73f54dbed0cd9a020000000000000000000000000000000000000000000000000000000000000000` |

The LaunchToken of every coin is created by the factory: verify the first one
once and Blockscout matches the rest by bytecode. The first is Notus:

| Contract | Address | File | Constructor arguments |
|---|---|---|---|
| LaunchToken (Notus, $NOTUS) | `0xFe236B0F050b93E3679fD96a659Adf53CF64eCdF` | `LaunchToken.standard-input.json` | `0x00000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000033b2e3c9fd0803ce80000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000cab79e85bfc71c30e5ba65d35e1a2e2d909c42ef00000000000000000000000000000000000000000000000000000000000000054e6f74757300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000054e4f545553000000000000000000000000000000000000000000000000000000` |

(name "Notus", symbol "NOTUS", supply 1000000000e18, transferable false, the Launchpad).

Links: https://base.blockscout.com/address/0xcaB79e85BfC71C30E5BA65d35e1a2e2D909C42EF?tab=contract ·
https://base.blockscout.com/address/0x0287eD7e89b1D7B69Db08B16020341151E93F530?tab=contract ·
https://base.blockscout.com/address/0x92329D494D4D098C95A87E381a4D60CA666edb1b?tab=contract ·
https://base.blockscout.com/address/0x2C3861638055A82782B8d30471c153B2DA00e756?tab=contract ·
https://base.blockscout.com/address/0x24dc2a849D3dbD93d8051d6C8d3215Be718B6Dd8?tab=contract

The earlier v9 stack at 30 cbLTC virtual (Launchpad 0x0ba4dD0782e10a1D3946531dACC12F3797b74955,
block 52,009,454) is the same code: the same files verify it, with its own addresses in the arguments.
