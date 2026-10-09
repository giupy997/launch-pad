// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {IDexMigrator} from "./interfaces/IDexMigrator.sol";

interface ILaunchpadPoolFees {
    function feeBps() external view returns (uint256);
    function treasury() external view returns (address);
    function distributePoolFee(address token, uint256 amount) external payable;
}

/// @title NotusV4Hook
/// @notice Graduation adapter and Uniswap v4 hook in one contract.
///
///         Migration: seeds a full-range Uniswap v4 pool with the graduated
///         token's DEX reserve and the quote raised on the curve (native ETH,
///         no WETH). The position belongs to this contract, which has no way
///         to remove liquidity: it is locked forever.
///
///         Fees: the pool itself charges 0%. On every swap this hook takes the
///         launchpad's trading fee (1%) in the pool's quote asset — whichever
///         direction and whichever amount the trader fixes — and hands it to
///         the launchpad, which splits it like a curve fee. A token launched
///         in holders mode therefore keeps paying its holders after it
///         graduates, for as long as its pool trades.
contract NotusV4Hook is IHooks, IDexMigrator, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using SafeCast for uint256;

    int24 public constant TICK_SPACING = 200;
    int24 public constant TICK_LOWER = -887_200; // full range, multiples of the spacing
    int24 public constant TICK_UPPER = 887_200;
    uint256 private constant BPS = 10_000;

    IPoolManager public immutable poolManager;
    address public immutable launchpad;

    struct PoolInfo {
        address token; // the graduated launch token
        Currency quote; // what the fee is taken in and paid out as
    }

    mapping(PoolId id => PoolInfo) public pools;
    /// Pool key per graduated token, for frontends and routers.
    mapping(address token => PoolKey) public poolKeys;

    event PoolCreated(address indexed token, bytes32 indexed poolId, uint256 quoteAmount, uint256 tokenAmount);
    event SwapFeeTaken(address indexed token, uint256 fee);

    error OnlyLaunchpad();
    error OnlyPoolManager();
    error WrongPayment();
    error PoolCreationNotAllowed();
    error HookNotImplemented();

    constructor(IPoolManager poolManager_, address launchpad_) {
        poolManager = poolManager_;
        launchpad = launchpad_;
        // reverts unless the deploy salt produced an address whose low bits
        // encode exactly these callbacks
        Hooks.validateHookPermissions(
            IHooks(address(this)),
            Hooks.Permissions({
                beforeInitialize: true,
                afterInitialize: false,
                beforeAddLiquidity: false,
                afterAddLiquidity: false,
                beforeRemoveLiquidity: false,
                afterRemoveLiquidity: false,
                beforeSwap: true,
                afterSwap: true,
                beforeDonate: false,
                afterDonate: false,
                beforeSwapReturnDelta: true,
                afterSwapReturnDelta: true,
                afterAddLiquidityReturnDelta: false,
                afterRemoveLiquidityReturnDelta: false
            })
        );
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        _;
    }

    // ------------------------------------------------------------ migration

    /// @inheritdoc IDexMigrator
    function migrate(address token, uint256 tokenAmount, address quoteAsset, uint256 quoteAmount)
        external
        payable
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        if (msg.value != (quoteAsset == address(0) ? quoteAmount : 0)) revert WrongPayment();

        Currency quote = Currency.wrap(quoteAsset);
        Currency launched = Currency.wrap(token);
        bool tokenIs0 = token < quoteAsset; // native ETH (address 0) always sorts first
        PoolKey memory key = PoolKey({
            currency0: tokenIs0 ? launched : quote,
            currency1: tokenIs0 ? quote : launched,
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
        (uint256 amount0, uint256 amount1) = tokenIs0 ? (tokenAmount, quoteAmount) : (quoteAmount, tokenAmount);

        // opening price from the migrated amounts: sqrt(amount1 / amount0) in Q96
        uint160 sqrtPriceX96 = uint160(Math.sqrt(Math.mulDiv(amount1, 1 << 192, amount0)));

        PoolId id = key.toId();
        pools[id] = PoolInfo({token: token, quote: quote});
        poolKeys[token] = key;

        // initialize skips beforeInitialize when the hook itself is the caller
        poolManager.initialize(key, sqrtPriceX96);
        poolManager.unlock(abi.encode(key, _fullRangeLiquidity(sqrtPriceX96, amount0, amount1)));

        // liquidity math rounds down, leaving dust on one side
        address treasury = ILaunchpadPoolFees(launchpad).treasury();
        _sweep(quote, treasury);
        _sweep(launched, treasury);

        emit PoolCreated(token, PoolId.unwrap(id), quoteAmount, tokenAmount);
    }

    function unlockCallback(bytes calldata data) external onlyPoolManager returns (bytes memory) {
        (PoolKey memory key, uint128 liquidity) = abi.decode(data, (PoolKey, uint128));
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: TICK_LOWER,
                tickUpper: TICK_UPPER,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );
        // adding liquidity leaves this contract owing both currencies
        _settle(key.currency0, uint256(int256(-delta.amount0())));
        _settle(key.currency1, uint256(int256(-delta.amount1())));
        return "";
    }

    function _fullRangeLiquidity(uint160 sqrtPriceX96, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint256 fromAmount0 = FullMath.mulDiv(
            amount0, FullMath.mulDiv(sqrtPriceX96, sqrtUpper, FixedPoint96.Q96), sqrtUpper - sqrtPriceX96
        );
        uint256 fromAmount1 = FullMath.mulDiv(amount1, FixedPoint96.Q96, sqrtPriceX96 - sqrtLower);
        return (fromAmount0 < fromAmount1 ? fromAmount0 : fromAmount1).toUint128();
    }

    function _settle(Currency currency, uint256 amount) internal {
        if (amount == 0) return;
        if (currency.isAddressZero()) {
            poolManager.settle{value: amount}();
        } else {
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
            poolManager.settle();
        }
    }

    function _sweep(Currency currency, address to) internal {
        uint256 balance = currency.balanceOfSelf();
        if (balance > 0) currency.transfer(to, balance);
    }

    // ---------------------------------------------------------------- hooks

    /// Only this contract may create pools bound to this hook, and the
    /// PoolManager does not call back into a hook for its own initialize —
    /// so reaching this means someone else is trying to.
    function beforeInitialize(address, PoolKey calldata, uint160) external pure returns (bytes4) {
        revert PoolCreationNotAllowed();
    }

    /// Takes the fee when the trader fixes the quote-asset amount: exact-input
    /// buys (fee out of what they pay) and exact-output sells (fee on top of
    /// what they receive). The swap is resized by the fee accordingly.
    function beforeSwap(address, PoolKey calldata key, IPoolManager.SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolInfo memory info = pools[key.toId()];
        bool exactInput = params.amountSpecified < 0;
        Currency specified = exactInput == params.zeroForOne ? key.currency0 : key.currency1;
        if (info.token == address(0) || !(specified == info.quote)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 amount = exactInput ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 fee = _fee(amount, exactInput);
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        _collect(info, fee);
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    /// Takes the fee when the quote-asset amount is the swap's result:
    /// exact-input sells (out of what they receive) and exact-output buys
    /// (on top of what they pay).
    function afterSwap(
        address,
        PoolKey calldata key,
        IPoolManager.SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external onlyPoolManager returns (bytes4, int128) {
        PoolInfo memory info = pools[key.toId()];
        bool exactInput = params.amountSpecified < 0;
        bool unspecifiedIs0 = exactInput != params.zeroForOne;
        Currency unspecified = unspecifiedIs0 ? key.currency0 : key.currency1;
        if (info.token == address(0) || !(unspecified == info.quote)) return (IHooks.afterSwap.selector, 0);

        int128 raw = unspecifiedIs0 ? delta.amount0() : delta.amount1();
        uint256 amount = raw < 0 ? uint256(int256(-raw)) : uint256(int256(raw));
        uint256 fee = _fee(amount, exactInput);
        if (fee == 0) return (IHooks.afterSwap.selector, 0);

        _collect(info, fee);
        return (IHooks.afterSwap.selector, fee.toInt128());
    }

    /// The fee is always bps of the quote amount the trader actually pays or
    /// receives: exact-input amounts already include it, exact-output
    /// amounts exclude it and are grossed up.
    function _fee(uint256 amount, bool amountIncludesFee) internal view returns (uint256) {
        uint256 bps = ILaunchpadPoolFees(launchpad).feeBps();
        return amountIncludesFee ? (amount * bps) / BPS : (amount * bps) / (BPS - bps);
    }

    /// Pulls the fee out of the PoolManager (the returned hook delta credits
    /// it back) and deposits it with the launchpad in the same swap.
    function _collect(PoolInfo memory info, uint256 fee) internal {
        poolManager.take(info.quote, address(this), fee);
        if (info.quote.isAddressZero()) {
            ILaunchpadPoolFees(launchpad).distributePoolFee{value: fee}(info.token, fee);
        } else {
            IERC20(Currency.unwrap(info.quote)).forceApprove(launchpad, fee);
            ILaunchpadPoolFees(launchpad).distributePoolFee(info.token, fee);
        }
        emit SwapFeeTaken(info.token, fee);
    }

    /// Native ETH only arrives from the PoolManager (fee takes).
    receive() external payable {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
    }

    // Callbacks this hook's address does not enable — never invoked.

    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function beforeAddLiquidity(address, PoolKey calldata, IPoolManager.ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        IPoolManager.ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }
}
