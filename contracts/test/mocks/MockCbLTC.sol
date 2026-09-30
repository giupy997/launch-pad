// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// cbLTC as tests and rehearsals see it: an eight-decimal ERC-20 anyone can mint.
contract MockCbLTC is ERC20 {
    constructor() ERC20("Coinbase Wrapped LTC", "cbLTC") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
