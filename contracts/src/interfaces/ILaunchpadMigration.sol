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
    function migrateToken(LaunchpadBase.LedgerCoin calldata coin, address[] calldata holders, uint256[] calldata balances)
        external
        payable
        returns (address token);
    function migrateBalances(address token, address[] calldata holders, uint256[] calldata balances) external;
    function announceFreeze(uint256 atBlock) external;
    function cancelFreeze() external;
    function migrateOut(address token, address to) external returns (uint256 quoteOut, uint256 tokensBurned);
}
