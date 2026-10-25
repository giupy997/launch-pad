// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {MockWETH9} from "./UniV2Mock.sol";
import {MockCbLTC} from "./MockCbLTC.sol";

/// Aerodrome Slipstream's SwapRouter as the zap sees it: exactInput in the
/// original v3 shape (a deadline, tick spacings in the path), one pool,
/// WETH/cbLTC at a fixed price, cbLTC minted on the way out and WETH wrapped
/// from the ETH this contract is given. Written for these tests.
contract MockSlipstreamRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    MockWETH9 public immutable weth;
    MockCbLTC public immutable cb;
    /// cbLTC (8 decimals) an ETH buys: 100, so 0.1 ETH is 10 cbLTC.
    uint256 public constant RATE = 100e8;

    constructor(MockWETH9 weth_, MockCbLTC cb_) {
        weth = weth_;
        cb = cb_;
    }

    receive() external payable {}

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        require(p.deadline >= block.timestamp, "Transaction too old");
        require(p.path.length == 43, "one pool here");
        address first = address(bytes20(p.path[:20]));
        address last = address(bytes20(p.path[p.path.length - 20:]));
        require(IERC20(first).transferFrom(msg.sender, address(this), p.amountIn), "STF");
        if (first == address(weth) && last == address(cb)) {
            amountOut = (p.amountIn * RATE) / 1e18;
            cb.mint(p.recipient, amountOut);
        } else if (first == address(cb) && last == address(weth)) {
            amountOut = (p.amountIn * 1e18) / RATE;
            weth.deposit{value: amountOut}();
            require(weth.transfer(p.recipient, amountOut), "transfer");
        } else {
            revert("no such pool");
        }
        require(amountOut >= p.amountOutMinimum, "Too little received");
    }
}
