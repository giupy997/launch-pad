// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";

/// Uniswap v2's Router02, the part of it a trader uses — the real interface
/// (Base's router is Uniswap's own code), declared minimally here.
interface IUniswapV2Router02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
    function getAmountsIn(uint256 amountOut, address[] calldata path) external view returns (uint256[] memory amounts);
    // exact input, plain: the router's figures assume the pair gets and delivers what it computes
    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    // exact input, fee-on-transfer aware: the router measures what the pair got and what `to` received
    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
    // exact output: no fee-on-transfer variant exists
    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
    function swapETHForExactTokens(uint256 amountOut, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// A Uniswap v2 pair, read.
interface IUniswapV2PairView {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// Uniswap v2's factory, read.
interface IUniswapV2FactoryView {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    /// Where the protocol's cut of the LP goes when the fee switch is on (address(0): off, as on Base).
    function feeTo() external view returns (address);
}

/// A fresh v12 stack on a fork of Base, its migrator bound to Base's real
/// Uniswap v2: a taxed coin is created, bought out so that it graduates into
/// a real pair, then traded through the real Router02 the way the site does
/// it — the fee-on-transfer functions — and the ways it must not: the plain
/// and the exact-output ones, which lie or fail on a coin that keeps its rate
/// on the way. Then a bystander harvests, and a plain transfer pays nothing.
/// The figures are §4 and §5 of the design replayed from the pad's and the
/// pair's state before each call, to the unit where the arithmetic is exact.
/// One contract per quote: the chain's ETH (the pool holds WETH), and cbLTC,
/// the quote the Base pad is deployed with, when `deal` can mint it on the fork.
/// No contract of the live stack is touched: everything is deployed here.
/// Run with: RUN_FORK_LIVE=true forge test --match-path 'test/V12Pool.fork.t.sol' -vv
///   (FORK_RPC overrides the Base node; the default is mainnet.base.org)
abstract contract V12PoolForkBase is Test {
    /// Uniswap v2 on Base: the factory the migrator creates its pairs on, and Router02, the one the site calls.
    address constant UNIV2_FACTORY = 0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6;
    address constant UNIV2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    /// Base's WETH (the OP-stack predeploy): what a native-quoted pool holds, and the router's WETH().
    address constant WETH = 0x4200000000000000000000000000000000000006;
    /// Coinbase Wrapped LTC (8 decimals): the quote the Base pad is deployed with.
    address constant CBLTC = 0xcb17C9Db87B595717C857a08468793f5bAb6445F;
    IUniswapV2Router02 constant ROUTER = IUniswapV2Router02(UNIV2_ROUTER);

    Launchpad pad;
    UniV2Migrator migrator;
    bool skipAll;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates the coin
    address bob = makeAddr("bob"); //     buys the curve out: the big holder, earning cashback
    address carol = makeAddr("carol"); // trades on the pool through the router
    address dave = makeAddr("dave"); //   harvests: no role, any EOA
    address erin = makeAddr("erin"); //   is paid wallet to wallet
    LaunchpadBase.TokenMetadata meta = LaunchpadBase.TokenMetadata("", "", "", "", "", "");
    /// 1% each way; the tax half to the creator, three tenths to holders, a tenth burned, a tenth to liquidity
    LaunchpadBase.FeeConfig taxed = LaunchpadBase.FeeConfig(100, 100, 5000, 3000, 1000, 1000, 0);
    /// The launchpad's fee as deployed, stamped on the coin: 0.5%
    uint256 constant PLATFORM = 50;
    /// What a pool trade pays either way, in coins: the launchpad's 0.5% and the coin's 1%
    uint256 constant RATE = PLATFORM + 100;

    /// The coin under test, graduated in setUp, and its pool on Base's Uniswap v2.
    address token;
    address pair;
    /// What the pair holds against the coin: WETH for a native quote, the ERC-20 otherwise.
    address pairAsset;

    // ------------------------------------------------- the quote: one contract each

    /// The curve's quote: address(0) for the chain's ETH, else the ERC-20.
    function _quote() internal view virtual returns (address);
    /// Switch the quote on and make sure the fork can fund it; false: this contract skips.
    function _enableQuote() internal virtual returns (bool);
    /// Give `who` `amount` of the quote to spend on the curve.
    function _fund(address who, uint256 amount) internal virtual;
    function _curveBuy(address who, uint256 amount) internal virtual;
    /// Enough to take the whole curve; the pad refunds the rest.
    function _graduationSpend() internal pure virtual returns (uint256);
    /// A buy on the pool: about 1.25% of the pool's quote side.
    function _poolSpend() internal pure virtual returns (uint256);
    /// What `who` holds of the quote as the pad pays it: the chain's coin, or the ERC-20.
    function _padQuote(address who) internal view virtual returns (uint256);
    /// Fund `who` with `quoteIn` of the quote and let the router pull it (nothing to approve for ETH).
    function _prepareBuy(address who, uint256 quoteIn) internal virtual;
    /// Let the router pull `who`'s coins.
    function _prepareSell(address who) internal virtual;
    /// The site's buy: swapExact…SupportingFeeOnTransferTokens, `quoteIn` in, at least `minOut` coins to `who`.
    function _routerBuy(address who, uint256 quoteIn, uint256 minOut) internal virtual;
    /// The site's sell: swapExact…SupportingFeeOnTransferTokens, `tokensIn` in, at least `minOut` of the quote to `who`.
    function _routerSell(address who, uint256 tokensIn, uint256 minOut) internal virtual;
    /// What a sell pays out on top of the pair's price: the ETH function pays out the router's whole
    /// WETH balance, strangers' dust included (0 for a token-for-token sell: the pair pays `who` directly).
    function _routerStray() internal view virtual returns (uint256);

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork(vm.envOr("FORK_RPC", string("https://mainnet.base.org")));
        pad = new Launchpad(treasury); // this contract owns it: no timelock on a fork
        migrator = new UniV2Migrator(address(pad), UNIV2_ROUTER); // finds the factory and WETH through the router
        pad.setMigrator(address(migrator));
        if (!_enableQuote()) {
            skipAll = true;
            return;
        }
        vm.prank(alice);
        token = pad.createTokenWithFees("Fork Taxed", "FTAX", 0, meta, _quote(), taxed);
        _fund(bob, _graduationSpend());
        _curveBuy(bob, _graduationSpend());
        (,,,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "one buy takes the whole curve: graduated, the pool seeded in the same call");
        pair = migrator.pairOf(token);
        pairAsset = migrator.pairAsset(token);
    }

    // ---------------------------------------------------------------- helpers

    function _path(address a, address b) internal pure returns (address[] memory p) {
        p = new address[](2);
        p[0] = a;
        p[1] = b;
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 600;
    }

    /// The pool's reserves as (coin, quote), whatever their order in the pair.
    function _reserves() internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = IUniswapV2PairView(pair).getReserves();
        (rToken, rQuote) = IUniswapV2PairView(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Uniswap v2's getAmountOut: the pool's own 0.3% on the way in.
    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    /// How the pad books a tax taken at the pool rate: the launchpad's part by platformBps over the rate, the rest the coin's.
    function _split(uint256 tax) internal pure returns (uint256 platform, uint256 pot) {
        platform = (tax * PLATFORM) / RATE;
        pot = tax - platform;
    }

    function _buckets() internal view returns (uint256) {
        return pad.taxTreasury(token) + pad.taxPot(token);
    }

    /// The pool holds no cashback, nor the pad, nor the migrator: what everyone else holds is the eligible supply.
    function _assertEligible() internal view {
        assertEq(
            pad.eligibleSupply(token),
            IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad)) - IERC20(token).balanceOf(pair)
                - IERC20(token).balanceOf(address(migrator)),
            "eligible supply: everything but the pad's, the pool's and the migrator's"
        );
    }

    /// Nothing stays with the migrator between calls: no quote, no coin of the chain, no coins.
    function _assertMigratorEmpty() internal view {
        assertEq(IERC20(pairAsset).balanceOf(address(migrator)), 0, "no quote left in the migrator");
        assertEq(address(migrator).balance, 0, "no coin of the chain either");
        assertEq(IERC20(token).balanceOf(address(migrator)), 0, "and no coins");
    }

    // ---------------------------------------------------------------- the stack

    /// The stack as deployed: the migrator found Base's factory and WETH through the router, the
    /// graduation created the pair on that factory, seeded it at the closing price and locked the
    /// LP in the migrator, and the pad registered the pair as the coin's taxed pool.
    function test_fork_graduationSeedsARealUniswapV2Pair() public view {
        if (skipAll) return;
        assertEq(address(migrator.router()), UNIV2_ROUTER);
        assertEq(address(migrator.factory()), UNIV2_FACTORY, "the factory the router names");
        assertEq(migrator.weth(), WETH, "the router's WETH");
        assertEq(ROUTER.factory(), UNIV2_FACTORY);
        assertEq(ROUTER.WETH(), WETH);
        assertTrue(pair != address(0), "the pool exists");
        assertEq(pair, IUniswapV2FactoryView(UNIV2_FACTORY).getPair(token, pairAsset), "the pool is the factory's pair");
        assertEq(pairAsset, _quote() == address(0) ? WETH : _quote(), "WETH stands in for a native quote");
        assertEq(address(pad.graduatedVia(token)), address(migrator), "seeded by this adapter");
        assertTrue(pad.taxedPool(token, pair), "registered: taxed, and no cashback on what it holds");
        // locked: every LP token but Uniswap's burned minimum is the migrator's
        assertGt(migrator.liquidity(token), 0, "the LP tokens are locked in the adapter");
        assertEq(IUniswapV2PairView(pair).balanceOf(address(migrator)), migrator.liquidity(token));
        assertEq(
            IUniswapV2PairView(pair).totalSupply(),
            migrator.liquidity(token) + 1000,
            "only MINIMUM_LIQUIDITY, burned by the pair, is not the migrator's"
        );
        (uint256 pT, uint256 pQ) = migrator.parked(token);
        assertEq(pT + pQ, 0, "nothing parked: a fresh pair takes everything");
        _assertMigratorEmpty();
        // the pool: the DEX reserve's share against the raise and the coin's liquidity pot, at the closing price
        (uint256 rToken, uint256 rQuote) = _reserves();
        assertEq(rToken + pad.lockedAtGraduation(token), pad.DEX_RESERVE(), "the pool and the lock share the DEX reserve");
        assertGt(pad.lockedAtGraduation(token), 0, "the curve's virtual share stays locked in the pad");
        (uint256 vEth, uint256 vToken,,,,,) = pad.curves(token);
        uint256 poolSide = rQuote * vToken;
        uint256 curveSide = vEth * rToken;
        uint256 diff = poolSide > curveSide ? poolSide - curveSide : curveSide - poolSide;
        assertLe(diff * 10_000, curveSide, "the pool opens at the price the curve closed at");
        assertEq(_buckets(), 0, "the seeding paid nothing: the buckets are empty when trading opens");
        _assertEligible();
    }

    // ---------------------------------------------------------------- the trades

    /// A buy as the site makes it (swapExact…SupportingFeeOnTransferTokens, the minimum set at the
    /// net): the pair pays out what the router quotes, the coin keeps the rate on the way to carol,
    /// who receives the quote net of 0.5% + 1%, and the pad books the tax split to the unit.
    function test_fork_aBuyThroughTheRouterPaysTheRateInCoins() public {
        if (skipAll) return;
        uint256 spend = _poolSpend();
        _prepareBuy(carol, spend);
        (uint256 rToken, uint256 rQuote) = _reserves();
        uint256 out = ROUTER.getAmountsOut(spend, _path(pairAsset, token))[1];
        assertEq(out, _amountOut(spend, rQuote, rToken), "the router quotes Uniswap's arithmetic on the pair's reserves");
        uint256 tax = (out * RATE) / 10_000;
        uint256 net = out - tax;
        uint256 padCoins = IERC20(token).balanceOf(address(pad));
        uint256 treasuryQ = _padQuote(treasury);
        vm.expectEmit(true, false, false, true, address(pad));
        emit LaunchpadBase.Taxed(token, true, tax);
        _routerBuy(carol, spend, net); // the minimum at the net: the router's own check passes exactly
        assertEq(IERC20(token).balanceOf(carol), net, "carol got the router's quote net of the rate");
        assertEq(IERC20(token).balanceOf(address(pad)) - padCoins, tax, "the tax went to the pad, in coins");
        (uint256 platform, uint256 pot) = _split(tax);
        assertGt(pot, 0);
        assertEq(pad.taxTreasury(token), platform, "the launchpad's part: the tax at platformBps over the rate");
        assertEq(pad.taxPot(token), pot, "the rest is the coin's");
        assertEq(platform, tax / 3, "a third of a 1.5% take is the 0.5%");
        (uint256 rToken2, uint256 rQuote2) = _reserves();
        assertEq(rToken2, rToken - out, "the pair paid the whole quote out: the tax came off carol's side");
        assertEq(rQuote2, rQuote + spend);
        assertEq(_padQuote(treasury), treasuryQ, "nothing in quote yet: the harvest sells the bucket");
        _assertEligible();
    }

    /// A sell as the site makes it: the router pulls bob's coins to the pair, the coin keeps the
    /// rate on that leg so the pair receives the net and prices that; bob gets exactly what
    /// getAmountsOut says for the net, and the buckets grow by the tax split.
    function test_fork_aSellThroughTheRouterPaysTheRateInCoins() public {
        if (skipAll) return;
        uint256 amount = 1_000_000e18; // of bob's 800M
        uint256 tax = (amount * RATE) / 10_000;
        uint256 net = amount - tax;
        _prepareSell(bob);
        (uint256 rToken, uint256 rQuote) = _reserves();
        uint256 quoted = ROUTER.getAmountsOut(net, _path(token, pairAsset))[1];
        assertEq(quoted, _amountOut(net, rToken, rQuote), "the router prices the net on the pair's reserves");
        uint256 bobQ = _padQuote(bob);
        uint256 stray = _routerStray();
        uint256 padCoins = IERC20(token).balanceOf(address(pad));
        vm.expectEmit(true, false, false, true, address(pad));
        emit LaunchpadBase.Taxed(token, false, tax);
        _routerSell(bob, amount, quoted); // the minimum at the quote for the net: passes exactly
        assertEq(_padQuote(bob) - bobQ, quoted + stray, "paid the pair's price for the net (plus what strangers left on the router)");
        assertEq(IERC20(token).balanceOf(address(pad)) - padCoins, tax, "the tax went to the pad, in coins");
        (uint256 platform, uint256 pot) = _split(tax);
        assertEq(pad.taxTreasury(token), platform, "the launchpad's part");
        assertEq(pad.taxPot(token), pot, "the coin's");
        (uint256 rToken2, uint256 rQuote2) = _reserves();
        assertEq(rToken2, rToken + net, "the pair holds the net");
        assertEq(rQuote2, rQuote - quoted);
        _assertEligible();
    }

    /// A wallet-to-wallet transfer pays nothing: the whole amount arrives, the pad is never asked
    /// to book a tax, the buckets stand still.
    function test_fork_aWalletToWalletTransferPaysNothing() public {
        if (skipAll) return;
        _prepareBuy(carol, _poolSpend());
        _routerBuy(carol, _poolSpend(), 0); // so the buckets hold something to compare against
        uint256 bucketT = pad.taxTreasury(token);
        uint256 bucketP = pad.taxPot(token);
        uint256 padCoins = IERC20(token).balanceOf(address(pad));
        uint256 amount = 1_000_000e18;

        vm.expectCall(address(pad), abi.encodeWithSelector(pad.onTax.selector), 0); // never asked to book a tax
        vm.prank(bob);
        IERC20(token).transfer(erin, amount);
        assertEq(IERC20(token).balanceOf(erin), amount, "whole");
        assertEq(pad.taxTreasury(token), bucketT, "the launchpad's bucket stands still");
        assertEq(pad.taxPot(token), bucketP, "the coin's too");
        assertEq(IERC20(token).balanceOf(address(pad)), padCoins, "nothing reached the pad");
        _assertEligible();
    }

    // ---------------------------------------------------------------- the harvest

    /// One harvest as §5 computes it from the state before the call.
    struct Exp {
        uint256 tT; //        taxTreasury before
        uint256 tP; //        taxPot before
        uint256 slice; //     min(total, cap)
        uint256 sT; //        of it, the launchpad's (pro rata)
        uint256 sP; //        and the coin's
        uint256 burnT;
        uint256 liqT;
        uint256 creatorT;
        uint256 holdersT;
        uint256 deepenT; //   the half of the liquidity share kept as coins (0: on the exact amounts the pool would mint nothing)
        bool doDeepen;
        uint256 sellT;
        uint256 quoteOut;
        uint256 qT; //        the treasury's quote, the tip already off
        uint256 qC;
        uint256 qH;
        uint256 qL;
        uint256 tip;
        uint256 lp;
        uint256 toBurnPot;
        uint256 rToken;
        uint256 rQuote;
    }

    /// What the balances were before a harvest.
    struct Snap {
        uint256 supply;
        uint256 burned;
        uint256 padTokens;
        uint256 treasuryQ;
        uint256 callerQ;
        uint256 padQ;
        uint256 creatorQ;
        uint256 burnPot;
        uint256 acc;
        uint256 lp;
        uint256 bobCashback;
        uint256 carolCashback;
    }

    /// §5, step by step, from the state before the call.
    function _expected() internal view returns (Exp memory e) {
        e.tT = pad.taxTreasury(token);
        e.tP = pad.taxPot(token);
        uint256 total = e.tT + e.tP;
        e.slice = Math.min(total, migrator.harvestCap(token));
        e.sT = (e.slice * e.tT) / total;
        e.sP = e.slice - e.sT;
        (,, uint16 creatorBps,, uint16 burnBps, uint16 liquidityBps,) = pad.feeConfig(token);
        e.burnT = (e.sP * burnBps) / 10_000;
        e.liqT = (e.sP * liquidityBps) / 10_000;
        e.creatorT = (e.sP * creatorBps) / 10_000;
        e.holdersT = e.sP - e.burnT - e.liqT - e.creatorT;
        (e.rToken, e.rQuote) = _reserves();
        uint256 lpTotal = IUniswapV2PairView(pair).totalSupply();
        // the liquidity leg on the exact amounts, as src/UniV2Migrator.sol decides it (the stack
        // here is built from src): the sale with half the share kept, that half's part of its
        // quote, both minted against the reserves the sale leaves
        e.deepenT = e.liqT / 2;
        e.sellT = e.slice - e.burnT - e.deepenT;
        e.quoteOut = _amountOut(e.sellT, e.rToken, e.rQuote);
        if (e.deepenT != 0) {
            uint256 qL = (e.quoteOut * (e.liqT - e.deepenT)) / e.sellT;
            e.doDeepen = qL != 0 && (e.deepenT * lpTotal) / (e.rToken + e.sellT) != 0
                && (qL * lpTotal) / (e.rQuote - e.quoteOut) != 0;
            if (!e.doDeepen) {
                e.deepenT = 0;
                e.sellT = e.slice - e.burnT;
                e.quoteOut = _amountOut(e.sellT, e.rToken, e.rQuote);
            }
        }
        e.qT = (e.quoteOut * e.sT) / e.sellT;
        e.qC = (e.quoteOut * e.creatorT) / e.sellT;
        e.qH = (e.quoteOut * e.holdersT) / e.sellT;
        e.qL = (e.quoteOut * (e.liqT - e.deepenT)) / e.sellT;
        e.qT += e.quoteOut - e.qT - e.qC - e.qH - e.qL; // dust to the treasury
        e.tip = e.qT / migrator.TIP_DIVISOR();
        e.qT -= e.tip;
        if (e.doDeepen) {
            // the pair mints against the reserves the sale left, the scarcer side deciding
            uint256 rT = e.rToken + e.sellT;
            uint256 rQ = e.rQuote - e.quoteOut;
            e.lp = Math.min((e.deepenT * lpTotal) / rT, (e.qL * lpTotal) / rQ);
        } else {
            e.toBurnPot = e.qL;
        }
    }

    function _snap(address caller) internal view returns (Snap memory s) {
        s.supply = IERC20(token).totalSupply();
        s.burned = pad.burned(token);
        s.padTokens = IERC20(token).balanceOf(address(pad));
        s.treasuryQ = _padQuote(treasury);
        s.callerQ = _padQuote(caller);
        s.padQ = _padQuote(address(pad));
        s.creatorQ = pad.creatorFees(alice, _quote());
        s.burnPot = pad.burnPot(token);
        s.acc = pad.accCashbackPerShare(token);
        s.lp = migrator.liquidity(token);
        s.bobCashback = pad.cashbackOf(token, bob);
        s.carolCashback = pad.cashbackOf(token, carol);
    }

    /// Everything a harvest leaves behind, against §5 — on the real pair.
    function _check(Exp memory e, Snap memory s, address caller) internal view {
        // the slice, pro rata across the two buckets
        assertEq(pad.taxTreasury(token), e.tT - e.sT, "the launchpad's bucket gave its pro rata part");
        assertEq(pad.taxPot(token), e.tP - e.sP, "the coin's bucket the rest");
        // the burn share: burned, never sold
        assertEq(IERC20(token).totalSupply(), s.supply - e.burnT, "the burn share is gone from the supply");
        assertEq(pad.burned(token), s.burned + e.burnT, "and counted");
        assertEq(IERC20(token).balanceOf(address(pad)), s.padTokens - e.slice, "the slice left the pad, burned or sold");
        assertEq(
            IERC20(token).balanceOf(address(pad)),
            pad.lockedAtGraduation(token) + pad.taxTreasury(token) + pad.taxPot(token),
            "the pad holds the lock and the buckets, nothing else"
        );
        // the liquidity share: deepened, or sold for the burn pot
        if (e.doDeepen) {
            assertGt(e.lp, 0);
            assertGt(migrator.liquidity(token), s.lp, "the locked position deepened");
            // Uniswap's own LP arithmetic, exact while the protocol's fee switch is off (it is, on Base)
            if (IUniswapV2FactoryView(UNIV2_FACTORY).feeTo() == address(0)) {
                assertEq(migrator.liquidity(token), s.lp + e.lp, "by what the pair mints for the scarcer side");
            }
            assertEq(pad.burnPot(token), s.burnPot, "nothing to the burn pot");
        } else {
            assertEq(e.lp, 0);
            assertEq(migrator.liquidity(token), s.lp, "nothing minted");
            assertEq(pad.burnPot(token), s.burnPot + e.qL, "the share's quote waits for a buyback");
        }
        assertEq(IUniswapV2PairView(pair).balanceOf(address(migrator)), migrator.liquidity(token), "the LP is the migrator's");
        // the quote: the treasury's part less the tip, the tip to the caller, creator and holders booked
        assertEq(_padQuote(treasury) - s.treasuryQ, e.qT, "the treasury: its part, the tip off");
        assertEq(_padQuote(caller) - s.callerQ, e.tip, "the caller: a twentieth of the treasury's part");
        assertEq(e.tip, (e.qT + e.tip) / 20);
        assertEq(pad.creatorFees(alice, _quote()) - s.creatorQ, e.qC, "the creator's share is claimable");
        assertEq(
            pad.accCashbackPerShare(token) - s.acc,
            (e.qH * 1e30) / pad.eligibleSupply(token),
            "the holders' share moved the accumulator"
        );
        assertEq(_padQuote(address(pad)) - s.padQ, e.qC + e.qH + e.toBurnPot, "the pad got what it books");
        _assertMigratorEmpty();
        // the holders' share reached the holders, pro rata; the pool and the migrator earn none
        uint256 eligible = pad.eligibleSupply(token);
        assertApproxEqAbs(
            pad.cashbackOf(token, bob) - s.bobCashback, (IERC20(token).balanceOf(bob) * e.qH) / eligible, 1, "bob's cashback"
        );
        assertApproxEqAbs(
            pad.cashbackOf(token, carol) - s.carolCashback,
            (IERC20(token).balanceOf(carol) * e.qH) / eligible,
            1,
            "carol's cashback"
        );
        assertEq(pad.cashbackOf(token, pair), 0, "the pool earns no cashback");
        assertEq(pad.cashbackOf(token, address(migrator)), 0, "nor the migrator");
        _assertEligible();
    }

    /// Carol buys and sells on the pool through the router; then dave, who holds nothing and has
    /// no role, harvests: the migrator takes the buckets (they fit under the cap), burns the burn
    /// share, sells the rest on the real pair, deepens the locked position with the liquidity
    /// share, pays the treasury, tips dave, books the creator's and the holders' shares — and keeps
    /// nothing. Then the cooldown: a second harvest in the same block waits, and the next block
    /// finds nothing to sell.
    function test_fork_anyoneHarvestsAndTheQuoteReachesEveryShare() public {
        if (skipAll) return;
        _prepareBuy(carol, _poolSpend());
        _routerBuy(carol, _poolSpend(), 0);
        _prepareSell(carol);
        _routerSell(carol, IERC20(token).balanceOf(carol) / 2, 0);
        assertGt(pad.taxTreasury(token), 0, "the launchpad's bucket filled");
        assertGt(pad.taxPot(token), 0, "the coin's too");

        Exp memory e = _expected();
        assertEq(e.slice, e.tT + e.tP, "the buckets fit under the cap: taken whole");
        assertTrue(e.doDeepen, "the liquidity share is big enough to mint on both sides");
        assertGt(e.burnT, 0);
        assertGt(e.tip, 0);
        Snap memory s = _snap(dave);
        vm.expectEmit(true, false, false, true, address(pad));
        emit LaunchpadBase.PoolFee(token, e.qT, e.qC, e.qH, e.toBurnPot);
        vm.prank(dave);
        (uint256 tokensIn, uint256 quoteOut, uint256 tokensBurned) = migrator.harvest(token);
        assertEq(tokensIn, e.slice, "coins taken");
        assertEq(quoteOut, e.quoteOut, "quote realised: Uniswap's arithmetic on the reserves before");
        assertEq(tokensBurned, e.burnT, "coins burned");
        _check(e, s, dave);
        assertEq(_buckets(), 0, "the buckets are empty");

        vm.prank(dave);
        vm.expectRevert(UniV2Migrator.HarvestCooldown.selector);
        migrator.harvest(token);
        vm.roll(block.number + 1);
        vm.prank(dave);
        vm.expectRevert(UniV2Migrator.NothingToSell.selector);
        migrator.harvest(token);
    }
}

/// The chain's ETH as the quote: the curve raises 4 ETH (1.25 virtual, on from birth), the pool holds
/// WETH, the router's ETH functions trade it, the harvest unwraps and the pad pays in ETH.
contract V12PoolEthForkTest is V12PoolForkBase {
    function _quote() internal pure override returns (address) {
        return address(0);
    }

    function _enableQuote() internal pure override returns (bool) {
        return true; // the native quote is on from the pad's birth
    }

    function _fund(address who, uint256 amount) internal override {
        vm.deal(who, who.balance + amount);
    }

    function _curveBuy(address who, uint256 amount) internal override {
        vm.prank(who);
        pad.buy{value: amount}(token, 0);
    }

    function _graduationSpend() internal pure override returns (uint256) {
        return 10 ether; // the curve raises 4 ETH plus the fee; the rest comes back
    }

    function _poolSpend() internal pure override returns (uint256) {
        return 0.05 ether; // 1.25% of the pool's 4 ETH side
    }

    function _padQuote(address who) internal view override returns (uint256) {
        return who.balance;
    }

    function _prepareBuy(address who, uint256 quoteIn) internal override {
        vm.deal(who, who.balance + quoteIn);
    }

    function _prepareSell(address who) internal override {
        vm.prank(who);
        IERC20(token).approve(UNIV2_ROUTER, type(uint256).max);
    }

    function _routerBuy(address who, uint256 quoteIn, uint256 minOut) internal override {
        vm.prank(who);
        ROUTER.swapExactETHForTokensSupportingFeeOnTransferTokens{value: quoteIn}(minOut, _path(WETH, token), who, _deadline());
    }

    function _routerSell(address who, uint256 tokensIn, uint256 minOut) internal override {
        vm.prank(who);
        ROUTER.swapExactTokensForETHSupportingFeeOnTransferTokens(tokensIn, minOut, _path(token, WETH), who, _deadline());
    }

    function _routerStray() internal view override returns (uint256) {
        return IERC20(WETH).balanceOf(UNIV2_ROUTER);
    }

    // ------------------------------------------- the router functions the site must not call

    /// The plain swapExactETHForTokens computes the pair's output and checks the minimum against
    /// that figure BEFORE the swap; the pair delivers it in full and the coin keeps the rate on the
    /// way, so carol receives less than the router returns — and less than the minimum she asked
    /// for, with no revert: a silent under-delivery. (The router only measures what `to` received
    /// in the …SupportingFeeOnTransferTokens variant.)
    function test_fork_thePlainBuyUnderDeliversSilently() public {
        if (skipAll) return;
        uint256 spend = 0.01 ether;
        vm.deal(carol, spend);
        address[] memory path = _path(WETH, token);
        uint256 out = ROUTER.getAmountsOut(spend, path)[1];
        vm.prank(carol);
        uint256[] memory amounts = ROUTER.swapExactETHForTokens{value: spend}(out, path, carol, _deadline());
        assertEq(amounts[1], out, "the router reports the pair's output as delivered");
        assertEq(IERC20(token).balanceOf(carol), out - (out * RATE) / 10_000, "carol got the output less the rate");
        assertLt(IERC20(token).balanceOf(carol), out, "below the minimum she set: the plain function never looks");
        assertEq(_buckets(), (out * RATE) / 10_000, "the difference sits in the pad's buckets");
    }

    /// The plain swapExactTokensForETH: the router's figures assume the pair receives what bob
    /// sends; the coin keeps the rate on that leg, the pair gets less, and its invariant check
    /// rejects the swap.
    function test_fork_thePlainSellRevertsInThePairsKCheck() public {
        if (skipAll) return;
        uint256 amount = 1_000_000e18;
        vm.startPrank(bob);
        IERC20(token).approve(UNIV2_ROUTER, amount);
        vm.expectRevert(bytes("UniswapV2: K"));
        ROUTER.swapExactTokensForETH(amount, 0, _path(token, WETH), bob, _deadline());
        vm.stopPrank();
    }

    /// Exact output, coins in: the router pulls getAmountsIn's gross from bob, the pair receives the
    /// net, and K rejects it. There is no fee-on-transfer variant of this function: unsupported.
    function test_fork_exactOutputSellRevertsInThePairsKCheck() public {
        if (skipAll) return;
        uint256 want = 0.001 ether;
        address[] memory path = _path(token, WETH);
        uint256 gross = ROUTER.getAmountsIn(want, path)[0];
        assertLt(gross, IERC20(token).balanceOf(bob), "bob can afford it");
        vm.startPrank(bob);
        IERC20(token).approve(UNIV2_ROUTER, gross);
        vm.expectRevert(bytes("UniswapV2: K"));
        ROUTER.swapTokensForExactETH(want, gross, path, bob, _deadline());
        vm.stopPrank();
    }

    /// Exact output, ETH in: the pair pays the exact amount out, the coin keeps the rate on the
    /// way, carol receives less than she asked for; the router refunds the ETH it did not need and
    /// reports the exact amount. Unsupported too.
    function test_fork_exactOutputBuyUnderDelivers() public {
        if (skipAll) return;
        uint256 want = 100_000e18;
        address[] memory path = _path(WETH, token);
        uint256 cost = ROUTER.getAmountsIn(want, path)[0];
        vm.deal(carol, 1 ether);
        vm.prank(carol);
        uint256[] memory amounts = ROUTER.swapETHForExactTokens{value: 1 ether}(want, path, carol, _deadline());
        assertEq(amounts[0], cost, "the router sized the input from the reserves alone");
        assertEq(amounts[1], want, "and reports the exact amount");
        assertEq(carol.balance, 1 ether - cost, "the ETH not needed came back");
        assertEq(IERC20(token).balanceOf(carol), want - (want * RATE) / 10_000, "but carol holds less than the exact amount");
        assertLt(IERC20(token).balanceOf(carol), want);
    }
}

/// cbLTC as the quote, as the Base pad is deployed (50 cbLTC virtual: the curve raises 160): the
/// pool is token/cbLTC, the router's token-for-token functions trade it, the harvest hands the pad
/// cbLTC by a transfer before poolFee and tips in cbLTC. The fork must be able to mint cbLTC with
/// `deal` (it writes the balance slot stdstore finds behind the token's proxy); when it cannot,
/// this contract skips and says so.
contract V12PoolCbLtcForkTest is V12PoolForkBase {
    IERC20 constant CB = IERC20(CBLTC);

    function _quote() internal pure override returns (address) {
        return CBLTC;
    }

    function _enableQuote() internal override returns (bool) {
        pad.setQuoteAsset(CBLTC, 50e8); // as DeployBase: 50 cbLTC virtual, 160 raised to graduate
        // `deal` as an external call, so a slot stdstore cannot find is a skip, not a failure
        try this.dealCbLtc(bob, 1e8) {}
        catch {
            emit log("cbLTC: deal() found no balance slot on the fork: the cbLTC contract is skipped");
            return false;
        }
        if (CB.balanceOf(bob) != 1e8) {
            emit log("cbLTC: deal() wrote, but balanceOf does not read it back: the cbLTC contract is skipped");
            return false;
        }
        return true;
    }

    /// Only this contract calls it (through `this`, for the try/catch): sets `to`'s cbLTC balance.
    function dealCbLtc(address to, uint256 amount) external {
        require(msg.sender == address(this), "not for anyone else");
        deal(CBLTC, to, amount);
    }

    function _fund(address who, uint256 amount) internal override {
        deal(CBLTC, who, CB.balanceOf(who) + amount); // deal sets, so add what is there
    }

    function _curveBuy(address who, uint256 amount) internal override {
        vm.startPrank(who);
        CB.approve(address(pad), amount);
        pad.buyWithQuote(token, amount, 0);
        vm.stopPrank();
    }

    function _graduationSpend() internal pure override returns (uint256) {
        return 300e8; // the curve raises 160 cbLTC plus the fee; the rest comes back
    }

    function _poolSpend() internal pure override returns (uint256) {
        return 2e8; // 1.25% of the pool's 160 cbLTC side
    }

    function _padQuote(address who) internal view override returns (uint256) {
        return CB.balanceOf(who);
    }

    function _prepareBuy(address who, uint256 quoteIn) internal override {
        _fund(who, quoteIn);
        vm.prank(who);
        CB.approve(UNIV2_ROUTER, type(uint256).max);
    }

    function _prepareSell(address who) internal override {
        vm.prank(who);
        IERC20(token).approve(UNIV2_ROUTER, type(uint256).max);
    }

    function _routerBuy(address who, uint256 quoteIn, uint256 minOut) internal override {
        vm.prank(who);
        ROUTER.swapExactTokensForTokensSupportingFeeOnTransferTokens(quoteIn, minOut, _path(CBLTC, token), who, _deadline());
    }

    function _routerSell(address who, uint256 tokensIn, uint256 minOut) internal override {
        vm.prank(who);
        ROUTER.swapExactTokensForTokensSupportingFeeOnTransferTokens(tokensIn, minOut, _path(token, CBLTC), who, _deadline());
    }

    function _routerStray() internal pure override returns (uint256) {
        return 0; // the pair pays the seller directly
    }

    // ------------------------------------------- the router functions the site must not call

    /// The plain swapExactTokensForTokens, cbLTC in: the router checks its own figure against the
    /// minimum before the swap, the pair delivers it whole, the coin keeps the rate on the way —
    /// carol gets less than the minimum she set, and no revert says so.
    function test_fork_thePlainBuyUnderDeliversSilently() public {
        if (skipAll) return;
        uint256 spend = 1e8;
        _prepareBuy(carol, spend);
        address[] memory path = _path(CBLTC, token);
        uint256 out = ROUTER.getAmountsOut(spend, path)[1];
        vm.prank(carol);
        uint256[] memory amounts = ROUTER.swapExactTokensForTokens(spend, out, path, carol, _deadline());
        assertEq(amounts[1], out, "the router reports the pair's output as delivered");
        assertEq(IERC20(token).balanceOf(carol), out - (out * RATE) / 10_000, "carol got the output less the rate");
        assertLt(IERC20(token).balanceOf(carol), out, "below the minimum she set: the plain function never looks");
        assertEq(_buckets(), (out * RATE) / 10_000, "the difference sits in the pad's buckets");
    }

    /// The plain swapExactTokensForTokens, coins in: the pair receives the net, the router's
    /// figures assumed the gross, the pair's invariant check rejects the swap.
    function test_fork_thePlainSellRevertsInThePairsKCheck() public {
        if (skipAll) return;
        uint256 amount = 1_000_000e18;
        vm.startPrank(bob);
        IERC20(token).approve(UNIV2_ROUTER, amount);
        vm.expectRevert(bytes("UniswapV2: K"));
        ROUTER.swapExactTokensForTokens(amount, 0, _path(token, CBLTC), bob, _deadline());
        vm.stopPrank();
    }

    /// Exact output, coins in: getAmountsIn's gross is pulled, the net arrives, K rejects it. Unsupported.
    function test_fork_exactOutputSellRevertsInThePairsKCheck() public {
        if (skipAll) return;
        uint256 want = 0.05e8;
        address[] memory path = _path(token, CBLTC);
        uint256 gross = ROUTER.getAmountsIn(want, path)[0];
        assertLt(gross, IERC20(token).balanceOf(bob), "bob can afford it");
        vm.startPrank(bob);
        IERC20(token).approve(UNIV2_ROUTER, gross);
        vm.expectRevert(bytes("UniswapV2: K"));
        ROUTER.swapTokensForExactTokens(want, gross, path, bob, _deadline());
        vm.stopPrank();
    }

    /// Exact output, cbLTC in: the router pulls exactly what the reserves say, the pair pays the exact
    /// amount out, the coin keeps the rate, carol holds less than she asked for. Unsupported too.
    function test_fork_exactOutputBuyUnderDelivers() public {
        if (skipAll) return;
        uint256 want = 100_000e18;
        address[] memory path = _path(CBLTC, token);
        uint256 cost = ROUTER.getAmountsIn(want, path)[0];
        _prepareBuy(carol, 10e8);
        uint256 cbBefore = CB.balanceOf(carol);
        vm.prank(carol);
        uint256[] memory amounts = ROUTER.swapTokensForExactTokens(want, 10e8, path, carol, _deadline());
        assertEq(amounts[0], cost, "the router sized the input from the reserves alone");
        assertEq(amounts[1], want, "and reports the exact amount");
        assertEq(cbBefore - CB.balanceOf(carol), cost, "exactly that much cbLTC was pulled");
        assertEq(IERC20(token).balanceOf(carol), want - (want * RATE) / 10_000, "but carol holds less than the exact amount");
        assertLt(IERC20(token).balanceOf(carol), want);
    }
}
