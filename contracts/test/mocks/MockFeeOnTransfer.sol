// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

/// A quote asset that keeps a hundredth of every transfer (burned): what the
/// launchpad must never credit for the amount asked.
contract MockFeeOnTransfer is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) return super._update(from, to, value);
        uint256 fee = value / 100;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee);
    }
}
