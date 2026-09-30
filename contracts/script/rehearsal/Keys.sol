// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Anvil's well-known accounts, for the local rehearsal only.
library Keys {
    uint256 constant DEPLOYER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant ALICE = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 constant BOB = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    uint256 constant CAROL = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6;
    string constant SOURCE = "../litecoin/migration/rehearsal-source.json";
    string constant TARGET = "../litecoin/migration/rehearsal-target.json";
}
