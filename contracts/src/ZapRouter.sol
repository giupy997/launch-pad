// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
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
        returns (uint256, uint256, uint256, uint256, bool graduated, address, address quoteAsset);
    function graduatedVia(address token) external view returns (address);
    function buy(address token, uint256 minTokensOut) external payable;
    function buyWithQuoteFor(address token, uint256 amountIn, uint256 minTokensOut, address recipient) external;
    function claimCashback(address token) external;
}

/// The migrator that seeded a coin's pool names the Uniswap v2 router it trades through.
interface IDexMigratorRouter {
    function router() external view returns (address);
}

/// The v2 router's exact-input swap that measures what the pair received and
/// what the recipient got: the one that works on a coin whose token keeps a
/// share of every transfer out of or into its pool (the pad's fee and the
/// coin's tax on v12).
interface IUniswapV2RouterZap {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title ZapRouter
/// @notice One-transaction ETH trades on asset-quoted coins. On the curve:
///         wraps ETH, swaps it to the curve's quote asset along a
///         caller-supplied Uniswap v3 path, and buys on the launchpad with the
///         caller as recipient — tokens, refunds and cashback all land on the
///         user. On the pool a coin graduated into: the same ETH → quote leg,
///         then the quote into the pool through the Uniswap v2 router the
///         pad's migrator seeded it on, the coins paid to the caller by the
///         pair itself; and the way back, coins → quote in the pool, quote →
///         ETH along the path, the ETH sent to the caller. Nothing stays here
///         between two transactions.
contract ZapRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable launchpad;
    ISwapRouter02 public immutable swapRouter;
    IWETH9 public immutable weth;

    event ZappedBuy(address indexed token, address indexed buyer, uint256 ethIn, uint256 quoteOut);
    /// An ETH buy in the coin's pool: the quote the ETH bought, the coins the pair paid the buyer.
    event ZappedPoolBuy(
        address indexed token, address indexed buyer, uint256 ethIn, uint256 quoteIn, uint256 tokensOut
    );
    /// A sale in the coin's pool for ETH: the quote the pair paid, the ETH it became.
    event ZappedPoolSell(
        address indexed token, address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 ethOut
    );

    error NotQuoteCurve();
    error PathMismatch();
    error ZeroAmount();
    error EthTransferFailed();
    /// The coin has no pool the launchpad knows: still on its curve, or graduated with no migrator set.
    error NoPool();

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
        _checkPath(path, address(weth), quote);

        weth.deposit{value: msg.value}();
        IERC20(address(weth)).forceApprove(address(swapRouter), msg.value);
        uint256 quoteOut = _swap(path, msg.value, minQuoteOut);

        IERC20(quote).forceApprove(launchpad, quoteOut);
        ILaunchpadZap(launchpad).buyWithQuoteFor(token, quoteOut, minTokensOut, msg.sender);

        emit ZappedBuy(token, msg.sender, msg.value, quoteOut);
    }

    /// @notice An ETH buy in the pool of a graduated coin: ETH → the coin's
    ///         quote along `path`, the quote → the coin in its pool. The pair
    ///         pays the caller directly, the coin's own charge on the way out
    ///         of the pool taken as on any pool buy, and the router checks
    ///         `minTokensOut` against what the caller really received.
    /// @param token         the graduated coin to buy
    /// @param path          Uniswap v3 path starting at WETH and ending at the coin's quote asset
    /// @param minQuoteOut   slippage guard on the ETH → quote leg (in quote asset units)
    /// @param minTokensOut  slippage guard on the pool leg (in coins, net of the coin's charge)
    function zapPoolBuy(address token, bytes calldata path, uint256 minQuoteOut, uint256 minTokensOut)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.value == 0) revert ZeroAmount();
        (address quote, IUniswapV2RouterZap dex) = _pool(token);
        _checkPath(path, address(weth), quote);

        weth.deposit{value: msg.value}();
        IERC20(address(weth)).forceApprove(address(swapRouter), msg.value);
        uint256 quoteOut = _swap(path, msg.value, minQuoteOut);

        IERC20(quote).forceApprove(address(dex), quoteOut);
        address[] memory route = new address[](2);
        route[0] = quote;
        route[1] = token;
        uint256 before = IERC20(token).balanceOf(msg.sender);
        // the transaction is its own deadline: mined now, or not at all
        dex.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            quoteOut, minTokensOut, route, msg.sender, block.timestamp
        );
        tokensOut = IERC20(token).balanceOf(msg.sender) - before;

        emit ZappedPoolBuy(token, msg.sender, msg.value, quoteOut, tokensOut);
    }

    /// @notice A sale in the pool of a graduated coin, paid in ETH: `amountIn`
    ///         coins taken from the caller (approved to this contract), sold
    ///         in the pool for the quote — the coin's charge on the way into
    ///         the pool taken as on any pool sell — the quote swapped to ETH
    ///         along `path` and sent to the caller.
    /// @param token         the graduated coin to sell
    /// @param amountIn      the coins to sell
    /// @param path          Uniswap v3 path starting at the coin's quote asset and ending at WETH
    /// @param minQuoteOut   slippage guard on the pool leg (in quote asset units)
    /// @param minEthOut     slippage guard on the quote → ETH leg (in wei)
    function zapPoolSell(address token, uint256 amountIn, bytes calldata path, uint256 minQuoteOut, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        (address quote, IUniswapV2RouterZap dex) = _pool(token);
        _checkPath(path, quote, address(weth));

        // from the caller to here: neither is a pool of the coin, so nothing is kept on the way
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(token).forceApprove(address(dex), amountIn);
        address[] memory route = new address[](2);
        route[0] = token;
        route[1] = quote;
        uint256 before = IERC20(quote).balanceOf(address(this));
        dex.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn, minQuoteOut, route, address(this), block.timestamp
        );
        uint256 quoteOut = IERC20(quote).balanceOf(address(this)) - before;

        IERC20(quote).forceApprove(address(swapRouter), quoteOut);
        ethOut = _swap(path, quoteOut, minEthOut);
        weth.withdraw(ethOut);
        (bool ok,) = msg.sender.call{value: ethOut}("");
        if (!ok) revert EthTransferFailed();

        emit ZappedPoolSell(token, msg.sender, amountIn, quoteOut, ethOut);
    }

    /// The pool of a graduated coin, as the launchpad knows it: the coin's
    /// quote asset and the Uniswap v2 router of the migrator that seeded it.
    function _pool(address token) internal view returns (address quote, IUniswapV2RouterZap dex) {
        bool graduated;
        (,,,, graduated,, quote) = ILaunchpadZap(launchpad).curves(token);
        if (quote == address(0)) revert NotQuoteCurve();
        address via = ILaunchpadZap(launchpad).graduatedVia(token);
        if (!graduated || via == address(0)) revert NoPool();
        dex = IUniswapV2RouterZap(IDexMigratorRouter(via).router());
    }

    /// A path must start and end exactly where the two legs meet.
    function _checkPath(bytes calldata path, address first, address last) internal pure {
        if (path.length < 40) revert PathMismatch();
        if (address(bytes20(path[:20])) != first) revert PathMismatch();
        if (address(bytes20(path[path.length - 20:])) != last) revert PathMismatch();
    }

    /// The DEX leg: `amountIn` of the path's first token (approved to the
    /// router by the caller of this function) along `path`, at least `minOut`
    /// of the path's last token, to this contract. SwapRouter02's shape here;
    /// a router of another shape overrides it (SlipstreamZapRouter).
    function _swap(bytes calldata path, uint256 amountIn, uint256 minOut) internal virtual returns (uint256) {
        return swapRouter.exactInput(
            ISwapRouter02.ExactInputParams({
                path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: minOut
            })
        );
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

        // Holding the pre-market for those two calls accrues holder cashback
        // to this router. It is paid in the pre-market's own quote (ETH), and
        // it was earned by this user's trade — claim it and hand it over with
        // the rest, so nothing is ever stranded here. Reverts when there is
        // nothing to claim, which is not an error.
        try ILaunchpadZap(launchpad).claimCashback(quote) {} catch {}

        // plus any surplus a graduating pre-market buy refunded to this router
        uint256 leftover = address(this).balance;
        if (leftover > 0) {
            (bool ok,) = msg.sender.call{value: leftover}("");
            if (!ok) revert EthTransferFailed();
        }

        emit ZappedBuy(token, msg.sender, msg.value, quoteOut);
    }

    /// Accepts graduation-buy refunds from the launchpad during zapBuyCurve,
    /// and WETH's ETH on a pool sale's way out.
    receive() external payable {}
}
