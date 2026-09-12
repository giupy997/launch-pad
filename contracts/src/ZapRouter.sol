// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface ILaunchpadZap {
    function curves(address token)
        external
        view
        returns (uint256, uint256, uint256, uint256, bool, address, address quoteAsset);
    function buy(address token, uint256 minTokensOut) external payable;
    function buyWithQuoteFor(address token, uint256 amountIn, uint256 minTokensOut, address recipient) external;
}

/// @title ZapRouter
/// @notice One-transaction ETH buys on asset-quoted curves: wraps ETH, swaps
///         it to the curve's quote asset along a caller-supplied Uniswap v3
///         path, and buys on the launchpad with the caller as recipient —
///         tokens, refunds and cashback all land on the user.
contract ZapRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable launchpad;
    ISwapRouter02 public immutable swapRouter;
    IWETH9 public immutable weth;

    event ZappedBuy(address indexed token, address indexed buyer, uint256 ethIn, uint256 quoteOut);

    error NotQuoteCurve();
    error PathMismatch();
    error ZeroAmount();
    error EthTransferFailed();

    constructor(address launchpad_, address swapRouter_, address weth_) {
        launchpad = launchpad_;
        swapRouter = ISwapRouter02(swapRouter_);
        weth = IWETH9(weth_);
    }

    /// @param token         the curve token to buy
    /// @param path          Uniswap v3 path starting at WETH and ending at the
    ///                      curve's quote asset (e.g. WETH-500-USDG-500-NVDA)
    /// @param minQuoteOut   swap slippage guard (in quote asset units)
    /// @param minTokensOut  curve slippage guard (in curve token units)
    function zapBuy(address token, bytes calldata path, uint256 minQuoteOut, uint256 minTokensOut)
        external
        payable
        nonReentrant
    {
        if (msg.value == 0) revert ZeroAmount();
        (,,,,,, address quote) = ILaunchpadZap(launchpad).curves(token);
        if (quote == address(0)) revert NotQuoteCurve();
        // path must start at WETH and end exactly at the curve's quote asset
        if (address(bytes20(path[:20])) != address(weth)) revert PathMismatch();
        if (address(bytes20(path[path.length - 20:])) != quote) revert PathMismatch();

        weth.deposit{value: msg.value}();
        IERC20(address(weth)).forceApprove(address(swapRouter), msg.value);
        uint256 quoteOut = swapRouter.exactInput(
            ISwapRouter02.ExactInputParams({
                path: path,
                recipient: address(this),
                amountIn: msg.value,
                amountOutMinimum: minQuoteOut
            })
        );

        IERC20(quote).forceApprove(launchpad, quoteOut);
        ILaunchpadZap(launchpad).buyWithQuoteFor(token, quoteOut, minTokensOut, msg.sender);

        emit ZappedBuy(token, msg.sender, msg.value, quoteOut);
    }

    /// @notice One-transaction ETH buy on a PRE-MARKET-quoted curve: buys the
    ///         quote asset on ITS OWN launchpad curve (no DEX involved), then
    ///         buys `token` with it for the caller. Works from day one — no
    ///         Uniswap pool needed for the pre-market.
    /// @param token         the curve token to buy (quoted in a pre-market)
    /// @param minQuoteOut   slippage guard on the pre-market curve leg
    /// @param minTokensOut  slippage guard on the token curve leg
    function zapBuyCurve(address token, uint256 minQuoteOut, uint256 minTokensOut) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        (,,,,,, address quote) = ILaunchpadZap(launchpad).curves(token);
        if (quote == address(0)) revert NotQuoteCurve();

        // leg 1: ETH -> pre-market on its own curve (reverts inside the
        // launchpad if `quote` is not a live ETH curve)
        ILaunchpadZap(launchpad).buy{value: msg.value}(quote, minQuoteOut);
        uint256 quoteOut = IERC20(quote).balanceOf(address(this));
        if (quoteOut == 0) revert ZeroAmount();

        // leg 2: pre-market -> token, recipient is the user
        IERC20(quote).forceApprove(launchpad, quoteOut);
        ILaunchpadZap(launchpad).buyWithQuoteFor(token, quoteOut, minTokensOut, msg.sender);

        // a graduating pre-market buy can refund surplus ETH to this router
        uint256 leftover = address(this).balance;
        if (leftover > 0) {
            (bool ok,) = msg.sender.call{value: leftover}("");
            if (!ok) revert EthTransferFailed();
        }

        emit ZappedBuy(token, msg.sender, msg.value, quoteOut);
    }

    /// Accepts graduation-buy refunds from the launchpad during zapBuyCurve.
    receive() external payable {}
}
