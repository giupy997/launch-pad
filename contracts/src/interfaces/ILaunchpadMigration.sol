// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchpadBase} from "../LaunchpadBase.sol";

/// @title ILaunchpadMigration
/// @notice The Launchpad's migration surface, served at the Launchpad's own
///         address by its migration module (LaunchpadMigration, run by
///         delegatecall from the Launchpad's fallback). Cast the launchpad's
///         address to this to call them: `ILaunchpadMigration(address(pad))`.
interface ILaunchpadMigration {
    function setMigrationOperator(address operator) external;
    function setMigrationRoot(bytes32 root, uint256 freezeHeight) external;
    function closeMigration() external;
    function migrateToken(
        LaunchpadBase.LedgerCoin calldata coin,
        bytes32[] calldata coinProof,
        LaunchpadBase.Delivery calldata first
    ) external payable returns (address token);
    function migrateBalances(address token, LaunchpadBase.Delivery calldata batch) external;
    function migrationLeafCoin(LaunchpadBase.LedgerCoin calldata coin) external pure returns (bytes32);
    function migrationLeafHolder(bytes32 symbolHash, address holder, uint256 amount) external pure returns (bytes32);
    function announceFreeze(uint256 atBlock) external;
    function cancelFreeze() external;
    function migrateOut(address token, address to) external returns (uint256 quoteOut, uint256 tokensBurned);
}
