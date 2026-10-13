// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Hashes} from "openzeppelin-contracts/contracts/utils/cryptography/Hashes.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";

/// The migration tree, built here the way script/merkle.mjs builds it for the
/// snapshot file and LaunchpadMigration checks it: one leaf per coin as the
/// ledger recorded it, one per holder's balance of it, in the file's order;
/// OpenZeppelin's standard leaves (the abi-encoded values hashed twice, so
/// no inner node can pose as a leaf) and pairs hashed sorted (MerkleProof);
/// an odd node is carried up unchanged. For the migration script and the
/// tests: the root of a set of leaves, the proof of one of them.
library MerkleTree {
    uint8 internal constant LEAF_COIN = 1;
    uint8 internal constant LEAF_HOLDER = 2;

    /// A coin's leaf: everything migrateToken is given about it.
    function coinLeaf(LaunchpadBase.LedgerCoin memory coin) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(LEAF_COIN, coin))));
    }

    /// A holder's leaf: the coin (by its own leaf), the holder, the balance.
    function holderLeaf(bytes32 coinLeaf, address holder, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(LEAF_HOLDER, coinLeaf, holder, amount))));
    }

    /// The root of `leaves`, as given (not sorted): zero for none.
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) return bytes32(0);
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            level = _parents(level);
        }
        return level[0];
    }

    /// The proof of `leaves[index]` against root(leaves): one sibling per level that has one.
    function proof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32[] memory p) {
        require(index < leaves.length, "MerkleTree: no such leaf");
        bytes32[] memory siblings = new bytes32[](64);
        uint256 n = 0;
        bytes32[] memory level = leaves;
        uint256 i = index;
        while (level.length > 1) {
            uint256 sibling = i ^ 1;
            if (sibling < level.length) siblings[n++] = level[sibling];
            level = _parents(level);
            i /= 2;
        }
        p = new bytes32[](n);
        for (uint256 k = 0; k < n; k++) {
            p[k] = siblings[k];
        }
    }

    function _parents(bytes32[] memory level) private pure returns (bytes32[] memory next) {
        next = new bytes32[]((level.length + 1) / 2);
        for (uint256 i = 0; i < level.length; i += 2) {
            next[i / 2] = i + 1 < level.length ? Hashes.commutativeKeccak256(level[i], level[i + 1]) : level[i];
        }
    }
}
