// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

interface ILaunchpadHook {
    function onTokenTransfer(address from, address to, uint256 value) external;
    /// True while the launchpad stands still for a migration to another
    /// chain, for a transfer of `token` from `from` — with the exceptions
    /// the launchpad makes (its own transfers, the pool being unlocked, the
    /// pool a migrated coin left).
    function frozenFor(address token, address from) external view returns (bool);
}

/// @title LaunchToken
/// @notice ERC-20 created by the Launchpad. The full supply is minted to the
///         launchpad, which sells it along a bonding curve. Transfers between
///         third parties are blocked until the token graduates, so liquidity
///         cannot be moved to a DEX before the curve completes. Every balance
///         change notifies the launchpad so holder-cashback accounting stays
///         exact (the hook is pure storage math and never reverts transfers).
contract LaunchToken is ERC20 {
    address public immutable launchpad;
    /// Pre-markets are transferable from day one so they can serve as quote
    /// assets (and migrate paired pools) while their own curve is still open.
    bool public immutable transferable;
    bool public graduated;

    error OnlyLaunchpad();
    error NotGraduated();
    /// The launchpad stands still for a migration: balances are being copied
    /// to another chain, so none may change.
    error Frozen();

    /// @param launchpad_ the launchpad the token answers to and is minted to
    ///        (its factory deploys the token on its behalf).
    constructor(string memory name_, string memory symbol_, uint256 supply_, bool transferable_, address launchpad_)
        ERC20(name_, symbol_)
    {
        launchpad = launchpad_;
        transferable = transferable_;
        _mint(launchpad_, supply_);
    }

    function setGraduated() external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        graduated = true;
    }

    /// @notice The launchpad burns its own tokens: at a migration, the token
    ///         side of an unlocked pool comes back to it and is retired here,
    ///         so the supply left is exactly what holders own.
    function burn(uint256 amount) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Pre-graduation, only flows through the launchpad (curve buys/sells,
        // mint, and the migration transfer) are allowed — unless the token
        // was created transferable (pre-markets).
        if (!graduated && !transferable && from != launchpad && to != launchpad && from != address(0)) {
            revert NotGraduated();
        }
        // Frozen for a migration: nothing moves (the mint at birth aside),
        // except what the launchpad itself still moves or lets out of a pool.
        if (from != address(0) && ILaunchpadHook(launchpad).frozenFor(address(this), from)) revert Frozen();
        super._update(from, to, value);
        // Settle cashback for both wallets right after balances change.
        ILaunchpadHook(launchpad).onTokenTransfer(from, to, value);
    }
}
