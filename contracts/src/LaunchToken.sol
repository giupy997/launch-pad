// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

interface ILaunchpadHook {
    function onTokenTransfer(address from, address to, uint256 value) external;
    /// What a transfer of `token` from `from` to `to` pays, in basis points
    /// (the launchpad's fee and the coin's tax, on a trade with one of the
    /// coin's pools; 0 for anything else), and a revert while the launchpad
    /// stands still for a migration — with the exceptions the launchpad makes
    /// (its own transfers, the pool being unlocked, the pool a migrated coin left).
    function transferRate(address token, address from, address to) external view returns (uint256 rateBps);
    /// The token took `amount` of itself as the fee on a trade from `from` to
    /// `to` and sent it to the launchpad: book it.
    function onTax(address from, address to, uint256 amount) external;
}

/// @title LaunchToken
/// @notice ERC-20 created by the Launchpad. The full supply is minted to the
///         launchpad, which sells it along a bonding curve. Transfers between
///         third parties are blocked until the token graduates, so liquidity
///         cannot be moved to a DEX before the curve completes. After it,
///         every transfer that touches one of the coin's pools — a buy, the
///         pool paying out; a sell, the pool being paid — leaves the fee the
///         launchpad names with the launchpad, in coins; the launchpad's
///         migrator sells those later. Every balance change notifies the
///         launchpad so holder-cashback accounting stays exact (the hook is
///         pure storage math and never reverts transfers).
contract LaunchToken is ERC20 {
    address public immutable launchpad;
    bool public graduated;
    /// The most a transfer can ever pay, whatever the launchpad answers: its
    /// fee's cap (5%) and the coin's tax cap (10%) together.
    uint256 public constant MAX_RATE = 1_500;

    error OnlyLaunchpad();
    error NotGraduated();
    /// The launchpad stands still for a migration: balances are being copied
    /// elsewhere, so none may change.
    error Frozen();

    /// @param launchpad_ the launchpad the token answers to and is minted to
    ///        (its factory deploys the token on its behalf).
    constructor(string memory name_, string memory symbol_, uint256 supply_, address launchpad_)
        ERC20(name_, symbol_)
    {
        launchpad = launchpad_;
        _mint(launchpad_, supply_);
    }

    function setGraduated() external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        graduated = true;
    }

    /// @notice The launchpad burns its own tokens: the burn share of the
    ///         pool fees, and at a migration the token side of an unlocked
    ///         pool that came back to it, so the supply left is exactly what
    ///         holders own.
    function burn(uint256 amount) external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // The launchpad says what this transfer pays, and refuses it while
        // frozen (the mint at birth aside).
        uint256 rate;
        if (from != address(0)) rate = ILaunchpadHook(launchpad).transferRate(address(this), from, to);
        // Pre-graduation, only flows through the launchpad (curve buys/sells,
        // mint, and the migration transfer) are allowed.
        if (!graduated && from != launchpad && to != launchpad && from != address(0)) revert NotGraduated();
        if (rate != 0) {
            if (rate > MAX_RATE) rate = MAX_RATE;
            uint256 tax = (value * rate) / 10_000;
            if (tax != 0) {
                _move(from, launchpad, tax);
                ILaunchpadHook(launchpad).onTax(from, to, tax);
                value -= tax;
            }
        }
        _move(from, to, value);
    }

    /// One balance change, then its cashback settlement: the launchpad reads
    /// the balances right after each move, so a move is never left unsettled
    /// while another happens.
    function _move(address from, address to, uint256 value) private {
        super._update(from, to, value);
        ILaunchpadHook(launchpad).onTokenTransfer(from, to, value);
    }
}
