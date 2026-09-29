// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IDexMigrator} from "./interfaces/IDexMigrator.sol";

interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function totalSupply() external view returns (uint256);
    function mint(address to) external returns (uint256 liquidity);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

interface ILaunchpadTreasury {
    function treasury() external view returns (address);
}

/// @title UniV2Migrator
/// @notice Graduation adapter for chains whose DEX is Uniswap v2 (LitVM at
///         launch): receives a graduated token's DEX reserve plus the quote
///         raised on the curve and seeds a v2 pool at the curve's final
///         price. The LP tokens stay in this contract forever — liquidity is
///         locked, nobody can pull it — and the pool's 0.3% swap fees simply
///         accrue to that locked position, deepening it.
///
///         The pair may already exist by the time a token graduates, and
///         anyone can put whatever they like in it beforehand, so nothing
///         here trusts its state: the pair is created if missing; a pair that
///         holds coins but no liquidity (a donation) is simply absorbed, our
///         deposit sets the price; a pair somebody already minted liquidity
///         in at their own price is first traded back to ours, then joined at
///         its ratio. The reserve always ends up in the pool at (about) the
///         price the curve closed at, never swept aside because the pool
///         disagreed.
contract UniV2Migrator is IDexMigrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable launchpad;
    IUniswapV2Router02 public immutable router;
    IUniswapV2Factory public immutable factory;
    address public immutable weth;

    /// The asset each token's pool is paired against (WETH for native curves).
    mapping(address token => address) public pairAsset;
    mapping(address token => uint256) public liquidity;

    /// A pool price within this much of ours is left alone (basis points).
    uint256 public constant PRICE_TOLERANCE_BPS = 50;

    event PoolSeeded(address indexed token, address pair, uint256 tokenAmount, uint256 quoteAmount, uint256 liquidity);
    /// The pool held liquidity at another price: what was traded to bring it to ours.
    event PoolRebalanced(address indexed token, address pair, uint256 tokenIn, uint256 quoteIn);

    error OnlyLaunchpad();
    error NothingToSeed();

    constructor(address launchpad_, address router_) {
        launchpad = launchpad_;
        router = IUniswapV2Router02(router_);
        factory = IUniswapV2Factory(IUniswapV2Router02(router_).factory());
        weth = IUniswapV2Router02(router_).WETH();
    }

    receive() external payable {}

    /// @inheritdoc IDexMigrator
    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable
        nonReentrant
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        address quote = quoteAsset;
        if (quoteAsset == address(0)) {
            quote = weth;
            quoteAmount = msg.value;
            IWETH(weth).deposit{value: msg.value}();
        }
        if (tokenAmount == 0 || quoteAmount == 0) revert NothingToSeed();

        address pair = factory.getPair(token, quote);
        if (pair == address(0)) pair = factory.createPair(token, quote);

        if (IUniswapV2Pair(pair).totalSupply() > 0) _rebalance(token, quote, pair, tokenAmount, quoteAmount);

        // what to deposit: everything, or (in a pool that has liquidity) the
        // largest amounts at the pool's ratio that we hold both sides of
        (uint256 useToken, uint256 useQuote) = _deposit(token, quote, pair);
        IERC20(token).safeTransfer(pair, useToken);
        IERC20(quote).safeTransfer(pair, useQuote);
        uint256 lp = IUniswapV2Pair(pair).mint(address(this));

        pairAsset[token] = quote;
        liquidity[token] += lp;

        // remainders (rounding, or a pool deeper than what we hold) go to the treasury
        _sweep(IERC20(token));
        if (quoteAsset == address(0)) {
            uint256 left = IERC20(weth).balanceOf(address(this));
            if (left > 0) IWETH(weth).withdraw(left);
            if (address(this).balance > 0) {
                (bool ok,) = ILaunchpadTreasury(launchpad).treasury().call{value: address(this).balance}("");
                ok; // best effort: a reverting treasury must never block a graduation
            }
        } else {
            _sweep(IERC20(quote));
        }
        emit PoolSeeded(token, pair, useToken, useQuote, lp);
    }

    /// @notice The locked pool of a graduated token.
    function pairOf(address token) external view returns (address) {
        return factory.getPair(token, pairAsset[token]);
    }

    /// The pool's reserves as (token, quote), whatever their order in the pair.
    function _reserves(address token, address pair) internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        (rToken, rQuote) = IUniswapV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Amounts to deposit from what we hold: all of it when the pool has no
    /// liquidity (our deposit sets the price; a donation is absorbed), else
    /// the pool's ratio, capped by the scarcer side.
    function _deposit(address token, address quote, address pair) internal view returns (uint256 useToken, uint256 useQuote) {
        useToken = IERC20(token).balanceOf(address(this));
        useQuote = IERC20(quote).balanceOf(address(this));
        if (IUniswapV2Pair(pair).totalSupply() == 0) return (useToken, useQuote);
        (uint256 rToken, uint256 rQuote) = _reserves(token, pair);
        uint256 quoteForAllTokens = Math.mulDiv(useToken, rQuote, rToken);
        if (quoteForAllTokens <= useQuote) return (useToken, quoteForAllTokens);
        return (Math.mulDiv(useQuote, rToken, rQuote), useQuote);
    }

    /// Somebody minted liquidity at a price of their own. Trade against it
    /// until its price is ours (the constant product tells exactly how much),
    /// as far as what we hold allows; they pay for the difference, we pay the
    /// pool's fee on the amount traded.
    function _rebalance(address token, address quote, address pair, uint256 tokenAmount, uint256 quoteAmount) internal {
        (uint256 rToken, uint256 rQuote) = _reserves(token, pair);
        if (rToken == 0 || rQuote == 0) return;
        // pool price vs ours, compared as cross products: rQuote/rToken vs quoteAmount/tokenAmount
        uint256 poolSide = rQuote * tokenAmount;
        uint256 ourSide = quoteAmount * rToken;
        uint256 tol = Math.mulDiv(ourSide, PRICE_TOLERANCE_BPS, 10_000);
        if (poolSide <= ourSide + tol && poolSide + tol >= ourSide) return;
        if (poolSide > ourSide) _sellTokens(token, pair, rToken, rQuote, tokenAmount, quoteAmount);
        else _buyTokens(token, quote, pair, rToken, rQuote, tokenAmount, quoteAmount);
    }

    /// Tokens are too expensive in the pool: sell some in, down to our price.
    function _sellTokens(address token, address pair, uint256 rToken, uint256 rQuote, uint256 tokenAmount, uint256 quoteAmount) internal {
        uint256 target = Math.sqrt(Math.mulDiv(rToken * rQuote, tokenAmount, quoteAmount)); // token reserve at our price
        if (target <= rToken) return;
        uint256 amountIn = ((target - rToken) * 1000) / 997 + 1;
        if (amountIn > tokenAmount) amountIn = tokenAmount;
        uint256 out = _amountOut(amountIn, rToken, rQuote);
        if (out == 0) return;
        IERC20(token).safeTransfer(pair, amountIn);
        _swapOut(pair, token, out, false);
        emit PoolRebalanced(token, pair, amountIn, 0);
    }

    /// Tokens are too cheap in the pool: buy some, up to our price.
    function _buyTokens(address token, address quote, address pair, uint256 rToken, uint256 rQuote, uint256 tokenAmount, uint256 quoteAmount) internal {
        uint256 target = Math.sqrt(Math.mulDiv(rToken * rQuote, quoteAmount, tokenAmount)); // quote reserve at our price
        if (target <= rQuote) return;
        uint256 amountIn = ((target - rQuote) * 1000) / 997 + 1;
        if (amountIn > quoteAmount) amountIn = quoteAmount;
        uint256 out = _amountOut(amountIn, rQuote, rToken);
        if (out == 0) return;
        IERC20(quote).safeTransfer(pair, amountIn);
        _swapOut(pair, token, out, true);
        emit PoolRebalanced(token, pair, 0, amountIn);
    }

    /// Take `out` of one side from the pair: the token side when `wantToken`, else the other.
    function _swapOut(address pair, address token, uint256 out, bool wantToken) internal {
        bool tokenIsZero = IUniswapV2Pair(pair).token0() == token;
        bool outIsZero = wantToken == tokenIsZero;
        IUniswapV2Pair(pair).swap(outIsZero ? out : 0, outIsZero ? 0 : out, address(this), "");
    }

    /// Uniswap v2's getAmountOut: the 0.3% fee on the way in.
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
    }

    function _sweep(IERC20 asset) internal {
        uint256 bal = asset.balanceOf(address(this));
        if (bal > 0) asset.safeTransfer(ILaunchpadTreasury(launchpad).treasury(), bal);
    }
}
