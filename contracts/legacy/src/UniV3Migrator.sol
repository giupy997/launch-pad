// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IDexMigrator} from "./interfaces/IDexMigrator.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

interface ILaunchpadView {
    function curves(address token)
        external
        view
        returns (uint256 vEth, uint256 vToken, uint256 realEth, uint256 sold, bool graduated, address creator, address quoteAsset);
    function feeRecipient(address token) external view returns (address);
    function treasury() external view returns (address);
}

/// @title UniV3Migrator
/// @notice Graduation adapter: receives a graduated token's DEX reserve plus
///         the ETH raised on the curve and seeds a full-range Uniswap v3 pool
///         (1% fee tier). The LP position NFT is held by this contract forever
///         — liquidity is locked, no one can pull it. The 1% trading fees the
///         pool earns are collectable by anyone and split between the token's
///         creator (honouring the launchpad's fee redirect) and the treasury.
contract UniV3Migrator is IDexMigrator, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10_000; // 1% tier
    int24 public constant TICK_RANGE = 887_200; // full range, multiple of spacing 200
    uint256 public constant CREATOR_SHARE_BPS = 5_000; // LP fees: 50% creator, 50% treasury

    address public immutable launchpad;
    INonfungiblePositionManager public immutable positionManager;
    IWETH9 public immutable weth;

    mapping(address token => uint256 tokenId) public positions;
    /// The asset each token's pool is paired against (WETH for ETH curves).
    mapping(address token => address) public pairAsset;

    event PoolCreated(address indexed token, address pool, uint256 tokenId, uint256 ethAmount, uint256 tokenAmount);
    event LpFeesCollected(address indexed token, uint256 creatorToken, uint256 creatorWeth, uint256 treasuryToken, uint256 treasuryWeth);

    error OnlyLaunchpad();
    error NotMigrated();

    constructor(address launchpad_, address positionManager_, address weth_) {
        launchpad = launchpad_;
        positionManager = INonfungiblePositionManager(positionManager_);
        weth = IWETH9(weth_);
    }

    /// @inheritdoc IDexMigrator
    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable
        nonReentrant
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();

        address quote;
        if (quoteAsset == address(0)) {
            weth.deposit{value: msg.value}();
            quote = address(weth);
            quoteAmount = msg.value;
        } else {
            quote = quoteAsset; // ERC-20 already transferred by the launchpad
        }
        pairAsset[token] = quote;

        (address token0, address token1) = token < quote ? (token, quote) : (quote, token);
        (uint256 amount0, uint256 amount1) =
            token < quote ? (tokenAmount, quoteAmount) : (quoteAmount, tokenAmount);

        // initial price from the migrated amounts: sqrt(amount1/amount0) in Q96
        uint160 sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));

        address pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE, sqrtPriceX96);

        IERC20(token).forceApprove(address(positionManager), tokenAmount);
        IERC20(quote).forceApprove(address(positionManager), quoteAmount);

        (uint256 tokenId,,,) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: -TICK_RANGE,
                tickUpper: TICK_RANGE,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp
            })
        );
        positions[token] = tokenId;

        // mint may leave small remainders; sweep them to the treasury
        _sweep(IERC20(token));
        _sweep(IERC20(quote));

        emit PoolCreated(token, pool, tokenId, quoteAmount, tokenAmount);
    }

    /// @notice Collect the LP fees earned by a graduated token's locked
    ///         position and split them creator/treasury. Anyone can call.
    function collectFees(address token) external nonReentrant {
        uint256 tokenId = positions[token];
        if (tokenId == 0) revert NotMigrated();

        (uint256 amount0, uint256 amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        address quote = pairAsset[token];
        (uint256 tokenAmt, uint256 wethAmt) =
            token < quote ? (amount0, amount1) : (amount1, amount0);

        (,,,,, address creator,) = ILaunchpadView(launchpad).curves(token);
        address redirect = ILaunchpadView(launchpad).feeRecipient(token);
        address creatorTo = redirect == address(0) ? creator : redirect;
        address treasury = ILaunchpadView(launchpad).treasury();

        uint256 creatorToken = (tokenAmt * CREATOR_SHARE_BPS) / 10_000;
        uint256 creatorWeth = (wethAmt * CREATOR_SHARE_BPS) / 10_000;
        if (creatorToken > 0) IERC20(token).safeTransfer(creatorTo, creatorToken);
        if (creatorWeth > 0) IERC20(quote).safeTransfer(creatorTo, creatorWeth);
        if (tokenAmt - creatorToken > 0) IERC20(token).safeTransfer(treasury, tokenAmt - creatorToken);
        if (wethAmt - creatorWeth > 0) IERC20(quote).safeTransfer(treasury, wethAmt - creatorWeth);

        emit LpFeesCollected(token, creatorToken, creatorWeth, tokenAmt - creatorToken, wethAmt - creatorWeth);
    }

    function _sweep(IERC20 asset) internal {
        uint256 bal = asset.balanceOf(address(this));
        if (bal > 0) asset.safeTransfer(ILaunchpadView(launchpad).treasury(), bal);
    }
}
