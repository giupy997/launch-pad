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
    /// @return pool        the pool the coin trades in from now on, which the
    ///                     launchpad registers (taxed, no cashback); address(0)
    ///                     when there is none to name
    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable
        returns (address pool);
}

/// @title IDexMigratorUnlock
/// @notice The way back: for a migration to another chain, the launchpad
///         (frozen) asks the adapter that seeded a graduated token's pool to
///         pull that liquidity out again. The quote side goes to `to` — the
///         account that bridges it — as the pool holds it (WETH for a native
///         pool: a transfer, never a call into `to` while the token's
///         transfers are open); the token side goes back to the caller, the
///         launchpad, which burns it; and the pool itself is returned, so the
///         launchpad can leave it open to withdrawals. Adapters that lock
///         liquidity in a way they cannot undo simply do not implement this.
interface IDexMigratorUnlock {
    function unlock(address token, address to) external returns (uint256 quoteOut, uint256 tokenOut, address pool);
}

/// @title IDexMigratorBuyback
/// @notice Buying a graduated token back on the pool the adapter seeded, with
///         quote the launchpad hands it first (as msg.value for a native pool,
///         as a transfer otherwise): the tokens bought go to the launchpad,
///         which burns them.
interface IDexMigratorBuyback {
    function buyback(address token, uint256 quoteIn) external payable returns (uint256 tokenOut);
    /// The most quote one buyback may spend on the token's pool right now: a
    /// slice small enough that a trade wrapped around it earns nothing.
    function buybackCap(address token) external view returns (uint256);
}

/// @title IDexMigratorHarvest
/// @notice Selling the fees a coin's pool trades left with the launchpad in
///         coins: the adapter takes a slice from the launchpad (takeTax),
///         sells it on the pool it seeded and hands the quote back (poolFee),
///         the burn share burned on the way and the liquidity share added to
///         the locked position when it can be.
interface IDexMigratorHarvest {
    function harvest(address token) external returns (uint256 tokensIn, uint256 quoteOut, uint256 tokensBurned);
    /// The most coins one harvest may sell on the token's pool right now.
    function harvestCap(address token) external view returns (uint256);
}
