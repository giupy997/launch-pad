// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ZapRouter} from "./ZapRouter.sol";

/// Aerodrome Slipstream's SwapRouter (Base) is Uniswap's original v3 SwapRouter
/// — exactInput takes a deadline, and the 3-byte value between two tokens of a
/// path is the pool's tick spacing, not a fee — where SwapRouter02 has neither.
/// The two shapes encode to different selectors: a call of one on the other
/// reverts, so a zap router is built for one router and one only.
interface ISlipstreamRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @title SlipstreamZapRouter
/// @notice The ZapRouter for a chain whose quote asset trades on Aerodrome
///         Slipstream — cbLTC on Base — with the DEX leg shaped for that
///         router. Paths carry tick spacings: WETH-200-cbLTC for the CL200 pool.
contract SlipstreamZapRouter is ZapRouter {
    constructor(address launchpad_, address swapRouter_, address weth_) ZapRouter(launchpad_, swapRouter_, weth_) {}

    function _swap(bytes calldata path, uint256 amountIn, uint256 minOut) internal override returns (uint256) {
        return ISlipstreamRouter(address(swapRouter)).exactInput(
            ISlipstreamRouter.ExactInputParams({
                path: path,
                recipient: address(this),
                // the transaction is its own deadline: mined now, or not at all
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minOut
            })
        );
    }
}
