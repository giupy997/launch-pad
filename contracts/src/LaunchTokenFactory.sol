// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchToken} from "./LaunchToken.sol";

/// @title LaunchTokenFactory
/// @notice Deploys LaunchTokens for the launchpad that made this factory,
///         keeping their creation code out of the launchpad's own runtime,
///         which has a size limit (EIP-170) and a migration to fit in.
///         Anyone may call it: a token made here is minted to its caller and
///         answers to it, so a stranger only ever makes a token of their own.
contract LaunchTokenFactory {
    function create(string calldata name, string calldata symbol, uint256 supply, bool transferable)
        external
        returns (address)
    {
        return address(new LaunchToken(name, symbol, supply, transferable, msg.sender));
    }
}
