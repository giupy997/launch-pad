// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDexMigrator
/// @notice Adapter that receives a graduated token's reserved supply plus the
///         quote raised on the curve and seeds liquidity on a DEX. One adapter
///         per chain keeps the Launchpad itself chain-agnostic.
interface IDexMigrator {
    /// @param token        the graduated token
    /// @param tokenAmount  tokens transferred to the migrator for liquidity
    /// @param quoteAsset   address(0) for native ETH (sent as msg.value),
    ///                     otherwise the ERC-20 already transferred here
    /// @param quoteAmount  amount of the quote asset provided
    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable;
}

/// @title IDexMigratorUnlock
/// @notice The way back: for a migration to another chain, the launchpad
///         (frozen) asks the adapter that seeded a graduated token's pool to
///         pull that liquidity out again. The quote side goes to `to` — the
///         account that bridges it — and the token side back to the caller,
///         the launchpad, which burns it. Adapters that lock liquidity in a
///         way they cannot undo simply do not implement this.
interface IDexMigratorUnlock {
    function unlock(address token, address to) external returns (uint256 quoteOut, uint256 tokenOut);
}
