// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {IDexMigrator, IDexMigratorUnlock, IDexMigratorBuyback} from "./interfaces/IDexMigrator.sol";

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
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
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
/// @notice Graduation adapter for chains whose DEX is Uniswap v2 (Base, LitVM):
///         receives a graduated token's DEX reserve plus the quote raised on
///         the curve and seeds a v2 pool at the curve's final price. The LP
///         tokens stay in this contract — liquidity is locked, nobody trades
///         it away — and the pool's 0.3% swap fees simply accrue to that
///         locked position, deepening it. The one way out is the launchpad's
///         migration to another chain: frozen, it asks for the pool back
///         (unlock), quote to the bridge, tokens to be burned.
///
///         The pair may already exist by the time this is called, and once a
///         coin has graduated anyone may put liquidity in it at any price
///         before the launchpad's (public) migrate lands — the window the
///         launchpad's try/catch around the automatic migration leaves open
///         when that call is starved of gas. So nothing here trusts the pair's
///         state, and nothing here trades against it. The first version did
///         ("trade the pool back to our price, then join it"), and that is how
///         both coins' raises were taken on Base at block 52,105,142: the
///         liquidity minted at the other price belonged to the attacker, who
///         was the one sold to, and who withdrew it with the raise inside.
///
///         Now: the pair is created if missing; a pair that holds coins but
///         no liquidity (a donation) is absorbed, our deposit sets the price;
///         a pair with liquidity at the curve's closing price (within
///         PRICE_TOLERANCE_BPS) is joined at its ratio; a pair with liquidity
///         at another price is traded to ours only when that costs next to
///         nothing — at most NUDGE_CAP_BPS of what we hold, which covers the
///         dust a drained pool keeps and nothing an attacker could profit
///         from — and otherwise is not joined at all: the reserve is parked
///         here, still the coin's, and anyone may `seed` it later, which lands
///         once the pool is back at our price (a mispriced pool is an
///         invitation to arbitrage it there). Nothing of ours is ever handed
///         to a price somebody else set.
contract UniV2Migrator is IDexMigrator, IDexMigratorUnlock, IDexMigratorBuyback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable launchpad;
    IUniswapV2Router02 public immutable router;
    IUniswapV2Factory public immutable factory;
    address public immutable weth;

    /// The asset each token's pool is paired against (WETH for native curves).
    mapping(address token => address) public pairAsset;
    /// The LP tokens this contract holds for each token: its locked liquidity.
    mapping(address token => uint256) public liquidity;

    /// What was handed over and has not reached the pool yet, because the
    /// pool held liquidity at another price when it was tried.
    struct Parked {
        uint256 tokenAmount;
        uint256 quoteAmount;
    }
    mapping(address token => Parked) public parked;
    /// The price the coin's pool is meant to open at — the curve's closing
    /// price, as what the launchpad handed over says it: quote per token.
    struct Price {
        uint256 tokenAmount;
        uint256 quoteAmount;
    }
    mapping(address token => Price) public closingPrice;

    /// A pool price within this much of ours is ours (basis points).
    uint256 public constant PRICE_TOLERANCE_BPS = 50;
    /// The most of what we hold one nudge of a mispriced pool may spend (basis points).
    uint256 public constant NUDGE_CAP_BPS = 10;
    /// A pool holding less than this fraction of what we hold, on both sides, is dust: joined whatever its ratio.
    uint256 public constant DUST_DIVISOR = 10_000;

    event PoolSeeded(address indexed token, address pair, uint256 tokenAmount, uint256 quoteAmount, uint256 liquidity);
    /// The pool held liquidity at another price: this much waits here until `seed` can land.
    event PoolParked(address indexed token, address pair, uint256 tokenAmount, uint256 quoteAmount);
    /// The pool held dust at another price: what was traded in to bring it to ours.
    event PoolNudged(address indexed token, address pair, uint256 tokenIn, uint256 quoteIn);
    /// The pool came back out for a migration: what our liquidity (and anything parked) was worth.
    event PoolUnlocked(address indexed token, address pair, uint256 tokenAmount, uint256 quoteAmount, uint256 liquidity);
    /// The launchpad bought the token back on its pool, to burn it.
    event BoughtBack(address indexed token, address pair, uint256 quoteIn, uint256 tokenOut);

    error OnlyLaunchpad();
    error NothingToSeed();
    error NothingToUnlock();
    error NothingToBuy();
    error WrongPayment();

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

        pairAsset[token] = quote;
        if (closingPrice[token].tokenAmount == 0) closingPrice[token] = Price(tokenAmount, quoteAmount);
        Parked storage p = parked[token];
        p.tokenAmount += tokenAmount;
        p.quoteAmount += quoteAmount;
        _seed(token, quote, _pair(token, quote));
    }

    /// @notice Put a parked reserve in its pool: anyone, any time. Lands when
    ///         the pool has no liquidity or holds it at our price; otherwise
    ///         the reserve keeps waiting, and the call says so.
    function seed(address token) external nonReentrant returns (bool seeded) {
        address quote = pairAsset[token];
        if (quote == address(0)) revert NothingToSeed();
        return _seed(token, quote, _pair(token, quote));
    }

    /// @inheritdoc IDexMigratorUnlock
    function unlock(address token, address to)
        external
        nonReentrant
        returns (uint256 quoteOut, uint256 tokenOut, address pair)
    {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        address quote = pairAsset[token];
        uint256 lp = liquidity[token];
        Parked memory p = parked[token];
        if (quote == address(0) || (lp == 0 && p.tokenAmount == 0 && p.quoteAmount == 0)) revert NothingToUnlock();
        liquidity[token] = 0;
        delete parked[token];
        pair = factory.getPair(token, quote);
        if (lp != 0) {
            // our share of the pool, swap fees included: the pair pays out against the LP it is handed
            IERC20(pair).safeTransfer(pair, lp);
            (uint256 amount0, uint256 amount1) = IUniswapV2Pair(pair).burn(address(this));
            (tokenOut, quoteOut) = IUniswapV2Pair(pair).token0() == token ? (amount0, amount1) : (amount1, amount0);
        }
        // and whatever never reached the pool
        tokenOut += p.tokenAmount;
        quoteOut += p.quoteAmount;
        IERC20(token).safeTransfer(launchpad, tokenOut);
        // the quote as the pool holds it — WETH for a native pool: a transfer,
        // never a call into `to` while the coin's transfers are open
        IERC20(quote).safeTransfer(to, quoteOut);
        emit PoolUnlocked(token, pair, tokenOut, quoteOut, lp);
    }

    /// @inheritdoc IDexMigratorBuyback
    /// @dev Only on a pool we hold liquidity in: one at another price, with
    ///      our reserve parked, is somebody else's and is not bought from.
    function buyback(address token, uint256 quoteIn) external payable nonReentrant returns (uint256 tokenOut) {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        address quote = pairAsset[token];
        if (quote == address(0) || liquidity[token] == 0 || quoteIn == 0) revert NothingToBuy();
        if (msg.value != 0) {
            if (quote != weth || msg.value != quoteIn) revert WrongPayment();
            IWETH(weth).deposit{value: msg.value}();
        }
        address pair = factory.getPair(token, quote);
        (uint256 rToken, uint256 rQuote) = _reserves(token, pair);
        // Uniswap's own arithmetic for a swap in, the 0.3% fee included
        tokenOut = (quoteIn * 997 * rToken) / (rQuote * 1000 + quoteIn * 997);
        if (tokenOut == 0) revert NothingToBuy();
        IERC20(quote).safeTransfer(pair, quoteIn);
        (uint256 out0, uint256 out1) =
            IUniswapV2Pair(pair).token0() == token ? (tokenOut, uint256(0)) : (uint256(0), tokenOut);
        IUniswapV2Pair(pair).swap(out0, out1, launchpad, "");
        emit BoughtBack(token, pair, quoteIn, tokenOut);
    }

    /// @inheritdoc IDexMigratorBuyback
    function buybackCap(address token) external view returns (uint256) {
        address quote = pairAsset[token];
        if (quote == address(0) || liquidity[token] == 0) return 0;
        (, uint256 rQuote) = _reserves(token, factory.getPair(token, quote));
        return rQuote / 200; // half a percent of the pool's quote side: less than Uniswap's fee both ways would cost a sandwich
    }

    /// @notice The locked pool of a graduated token.
    function pairOf(address token) external view returns (address) {
        return factory.getPair(token, pairAsset[token]);
    }

    /// The pair for a token and its quote, created if missing.
    function _pair(address token, address quote) internal returns (address pair) {
        pair = factory.getPair(token, quote);
        if (pair == address(0)) pair = factory.createPair(token, quote);
    }

    /// Deposit what is parked, if the pool is at (about) the closing price
    /// or can be brought there for next to nothing; what the pool's ratio
    /// leaves over goes to the treasury, as before. Otherwise everything
    /// stays parked.
    function _seed(address token, address quote, address pair) internal returns (bool seeded) {
        Parked memory p = parked[token];
        if (p.tokenAmount == 0 || p.quoteAmount == 0) return false;
        Price memory ours = closingPrice[token];
        (uint256 useToken, uint256 useQuote) = _deposit(token, pair, p, ours, true);
        if (useToken == 0 || useQuote == 0) {
            if (!_nudge(token, quote, pair, p, ours)) {
                emit PoolParked(token, pair, p.tokenAmount, p.quoteAmount);
                return false;
            }
            p = parked[token]; // the nudge moved some of it
            (useToken, useQuote) = _deposit(token, pair, p, ours, false);
            if (useToken == 0 || useQuote == 0) {
                emit PoolParked(token, pair, p.tokenAmount, p.quoteAmount);
                return false;
            }
        }
        delete parked[token];
        IERC20(token).safeTransfer(pair, useToken);
        IERC20(quote).safeTransfer(pair, useQuote);
        uint256 lp = IUniswapV2Pair(pair).mint(address(this));
        liquidity[token] += lp;
        emit PoolSeeded(token, pair, useToken, useQuote, lp);

        // what the pool's ratio left over (rounding, or a pool deeper than what we hold) goes to the treasury
        address treasury = ILaunchpadTreasury(launchpad).treasury();
        if (p.tokenAmount > useToken) IERC20(token).safeTransfer(treasury, p.tokenAmount - useToken);
        uint256 left = p.quoteAmount - useQuote;
        if (left > 0) {
            if (quote == weth) {
                IWETH(weth).withdraw(left);
                (bool ok,) = treasury.call{value: left}("");
                ok; // best effort: a reverting treasury must never block a graduation
            } else {
                IERC20(quote).safeTransfer(treasury, left);
            }
        }
        return true;
    }

    /// Amounts to deposit from what is parked: all of it when the pool has no
    /// liquidity (our deposit sets the price; a donation is absorbed); at the
    /// pool's ratio, capped by the scarcer side, when its price is ours (or
    /// when `checkPrice` is off, right after a nudge put it there); nothing
    /// when it is not.
    function _deposit(address token, address pair, Parked memory p, Price memory ours, bool checkPrice)
        internal
        view
        returns (uint256 useToken, uint256 useQuote)
    {
        if (IUniswapV2Pair(pair).totalSupply() == 0) return (p.tokenAmount, p.quoteAmount);
        (uint256 rToken, uint256 rQuote) = _reserves(token, pair);
        // dust on both sides next to what we hold (what a drained pool keeps,
        // at whatever ratio): our deposit sets the price, and whoever owns
        // the dust gets that share of the pool, a ten-thousandth at most
        if (rToken * DUST_DIVISOR <= p.tokenAmount && rQuote * DUST_DIVISOR <= p.quoteAmount) return (p.tokenAmount, p.quoteAmount);
        if (rToken == 0 || rQuote == 0) return (0, 0);
        if (checkPrice) {
            // pool price vs ours, compared as cross products: rQuote/rToken vs ours.quoteAmount/ours.tokenAmount
            uint256 poolSide = rQuote * ours.tokenAmount;
            uint256 ourSide = ours.quoteAmount * rToken;
            uint256 tol = Math.mulDiv(ourSide, PRICE_TOLERANCE_BPS, 10_000);
            if (poolSide > ourSide + tol || poolSide + tol < ourSide) return (0, 0);
        }
        uint256 quoteForAllTokens = Math.mulDiv(p.tokenAmount, rQuote, rToken);
        if (quoteForAllTokens <= p.quoteAmount) return (p.tokenAmount, quoteForAllTokens);
        return (Math.mulDiv(p.quoteAmount, rToken, rQuote), p.quoteAmount);
    }

    /// A pool at another price, moved to ours by trading into it — but only
    /// when that spends at most NUDGE_CAP_BPS of what we hold: the dust a
    /// drained pool keeps costs nothing to move, and a pool big enough to
    /// cost more is somebody's capital at a wrong price, left to arbitrage.
    /// Selling tokens into a pool that prices them too high is bounded the
    /// same way, and only ever brings quote back.
    function _nudge(address token, address quote, address pair, Parked memory p, Price memory ours)
        internal
        returns (bool)
    {
        (uint256 rToken, uint256 rQuote) = _reserves(token, pair);
        if (rToken == 0 || rQuote == 0) return false;
        uint256 k = rToken * rQuote;
        if (rQuote * ours.tokenAmount > ours.quoteAmount * rToken) {
            // tokens too dear there: sell some in, down to our price
            uint256 target = Math.sqrt(Math.mulDiv(k, ours.tokenAmount, ours.quoteAmount)); // token reserve at our price
            if (target <= rToken) return false;
            uint256 amountIn = ((target - rToken) * 1000) / 997 + 1;
            if (amountIn > Math.mulDiv(p.tokenAmount, NUDGE_CAP_BPS, 10_000)) return false;
            uint256 out = _amountOut(amountIn, rToken, rQuote);
            if (out == 0) return false;
            parked[token].tokenAmount -= amountIn;
            parked[token].quoteAmount += out;
            IERC20(token).safeTransfer(pair, amountIn);
            _swapOut(pair, token, out, false);
            emit PoolNudged(token, pair, amountIn, 0);
        } else {
            // tokens too cheap there: buy some, up to our price
            uint256 target = Math.sqrt(Math.mulDiv(k, ours.quoteAmount, ours.tokenAmount)); // quote reserve at our price
            if (target <= rQuote) return false;
            uint256 amountIn = ((target - rQuote) * 1000) / 997 + 1;
            if (amountIn > Math.mulDiv(p.quoteAmount, NUDGE_CAP_BPS, 10_000)) return false;
            uint256 out = _amountOut(amountIn, rQuote, rToken);
            if (out == 0) return false;
            parked[token].quoteAmount -= amountIn;
            parked[token].tokenAmount += out;
            IERC20(quote).safeTransfer(pair, amountIn);
            _swapOut(pair, token, out, true);
            emit PoolNudged(token, pair, 0, amountIn);
        }
        return true;
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

    /// The pool's reserves as (token, quote), whatever their order in the pair.
    function _reserves(address token, address pair) internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = IUniswapV2Pair(pair).getReserves();
        (rToken, rQuote) = IUniswapV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
    }
}
