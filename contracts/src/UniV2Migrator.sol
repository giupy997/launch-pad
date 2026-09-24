// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IDexMigrator} from "./interfaces/IDexMigrator.sol";

interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
}

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
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
contract UniV2Migrator is IDexMigrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable launchpad;
    IUniswapV2Router02 public immutable router;

    /// The asset each token's pool is paired against (WETH for native curves).
    mapping(address token => address) public pairAsset;
    mapping(address token => uint256) public liquidity;

    event PoolSeeded(address indexed token, address pair, uint256 tokenAmount, uint256 quoteAmount, uint256 liquidity);

    error OnlyLaunchpad();

    constructor(address launchpad_, address router_) {
        launchpad = launchpad_;
        router = IUniswapV2Router02(router_);
    }

    /// @inheritdoc IDexMigrator
    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable
        nonReentrant
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        IERC20(token).forceApprove(address(router), tokenAmount);

        uint256 usedToken;
        uint256 usedQuote;
        uint256 lp;
        address quote;
        if (quoteAsset == address(0)) {
            quote = router.WETH();
            (usedToken, usedQuote, lp) =
                router.addLiquidityETH{value: msg.value}(token, tokenAmount, 0, 0, address(this), block.timestamp);
        } else {
            quote = quoteAsset; // already transferred here by the launchpad
            IERC20(quote).forceApprove(address(router), quoteAmount);
            (usedToken, usedQuote, lp) =
                router.addLiquidity(token, quote, tokenAmount, quoteAmount, 0, 0, address(this), block.timestamp);
        }
        pairAsset[token] = quote;
        liquidity[token] += lp;

        // the router may leave small remainders; sweep them to the treasury
        _sweep(IERC20(token));
        if (quoteAsset != address(0)) _sweep(IERC20(quote));
        if (address(this).balance > 0) {
            (bool ok,) = ILaunchpadTreasury(launchpad).treasury().call{value: address(this).balance}("");
            ok; // best effort: a reverting treasury must never block a graduation
        }

        emit PoolSeeded(token, IUniswapV2Factory(router.factory()).getPair(token, quote), usedToken, usedQuote, lp);
    }

    /// @notice The locked pool of a graduated token.
    function pairOf(address token) external view returns (address) {
        return IUniswapV2Factory(router.factory()).getPair(token, pairAsset[token]);
    }

    function _sweep(IERC20 asset) internal {
        uint256 bal = asset.balanceOf(address(this));
        if (bal > 0) asset.safeTransfer(ILaunchpadTreasury(launchpad).treasury(), bal);
    }

    receive() external payable {}
}
