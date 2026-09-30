// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchToken} from "./LaunchToken.sol";

/// @title LaunchTokenFactory
/// @notice Deploys LaunchTokens for the launchpad that made this factory,
///         keeping their creation code out of the launchpad's own runtime,
///         which has a size limit (EIP-170) and a migration to fit in. Only
///         that launchpad may call it, so every token born here is one of
///         its coins and nothing else can pass for one.
contract LaunchTokenFactory {
    address public immutable launchpad;

    error OnlyLaunchpad();

    constructor() {
        launchpad = msg.sender;
    }

    function create(string calldata name, string calldata symbol, uint256 supply, bool transferable)
        external
        returns (address)
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        return address(new LaunchToken(name, symbol, supply, transferable, msg.sender));
    }
}
