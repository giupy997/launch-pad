// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {SlipstreamZapRouter} from "../src/SlipstreamZapRouter.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {MockV2Factory, MockV2Pair, MockV2Router, MockWETH9} from "./mocks/UniV2Mock.sol";
import {MockCbLTC} from "./mocks/MockCbLTC.sol";
import {MockSlipstreamRouter} from "./mocks/MockSlipstreamRouter.sol";

/// The zap's two pool legs on a graduated, taxed, cbLTC-quoted coin: an ETH buy
/// that lands the coins on the caller with the coin's charge taken as on any
/// pool buy, a sale paid in ETH with the charge taken on the way in, every
/// minimum checked on the leg it guards, the paths checked against the legs,
/// a coin with no pool refused, and nothing ever left in the zap. The pad, the
/// token and the migrator are the real contracts; the DEXes are mocks with
/// Uniswap's arithmetic (v2) and a fixed WETH/cbLTC price (Slipstream).
contract ZapPoolTest is Test {
    Launchpad pad;
    UniV2Migrator migrator;
    MockWETH9 weth;
    MockV2Factory factory;
    MockCbLTC cb;
    MockSlipstreamRouter dex;
    SlipstreamZapRouter zap;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates the coin
    address bob = makeAddr("bob"); //     buys its curve out
    address carol = makeAddr("carol"); // trades in ETH through the zap
    LaunchpadBase.TokenMetadata meta = LaunchpadBase.TokenMetadata("", "", "", "", "", "");
    /// Notus's own: 1% each way, the pot a quarter to the creator, half burned, a quarter to liquidity
    LaunchpadBase.FeeConfig notus = LaunchpadBase.FeeConfig(100, 100, 2500, 0, 5000, 2500, 0);
    address token;
    MockV2Pair pair;
    /// what a pool buy or sell pays the pad on a v12 coin with that tax: the launchpad's 0.5% and the 1%
    uint256 constant RATE_BPS = 150;

    function setUp() public {
        pad = new Launchpad(treasury);
        cb = new MockCbLTC();
        pad.setQuoteAsset(address(cb), 50e8); // as on Base: 160 cbLTC to graduate
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        pad.setMigrator(address(migrator));
        dex = new MockSlipstreamRouter(weth, cb);
        vm.deal(address(dex), 1_000 ether); // the ETH its cbLTC → WETH leg wraps
        zap = new SlipstreamZapRouter(address(pad), address(dex), address(weth));
        vm.deal(carol, 10 ether);

        vm.prank(alice);
        token = pad.createTokenWithFees("Notus", "NOTUS", 0, meta, address(cb), notus);
        cb.mint(bob, 200e8);
        vm.startPrank(bob);
        cb.approve(address(pad), 200e8);
        pad.buyWithQuote(token, 200e8, 0); // the curve raises 160: this crosses the line
        vm.stopPrank();
        (,,,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "graduated");
        pair = MockV2Pair(migrator.pairOf(token));
        assertGt(migrator.liquidity(token), 0, "the pool is seeded");
    }

    // ---------------------------------------------------------------- helpers

    /// the site's route in: WETH → cbLTC on the CL200 pool
    function _in() internal view returns (bytes memory) {
        return abi.encodePacked(address(weth), uint24(200), address(cb));
    }

    /// and out: cbLTC → WETH
    function _out() internal view returns (bytes memory) {
        return abi.encodePacked(address(cb), uint24(200), address(weth));
    }

    function _reserves() internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rToken, rQuote) = pair.token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Uniswap v2's getAmountOut: the 0.3% fee on the way in.
    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * reserveOut) / (reserveIn * 1000 + inWithFee);
    }

    /// The zap holds nothing of anything it touched: ETH, WETH, the quote, the coin.
    function _zapIsEmpty() internal view {
        assertEq(address(zap).balance, 0, "no ETH left in the zap");
        assertEq(weth.balanceOf(address(zap)), 0, "no WETH left in the zap");
        assertEq(cb.balanceOf(address(zap)), 0, "no cbLTC left in the zap");
        assertEq(LaunchToken(token).balanceOf(address(zap)), 0, "no coins left in the zap");
    }

    /// Carol buys with `ethIn` through the zap: returns what the pair paid out and what she kept.
    function _buy(uint256 ethIn) internal returns (uint256 pairOut, uint256 got) {
        (uint256 rToken, uint256 rQuote) = _reserves();
        uint256 quoteIn = (ethIn * dex.RATE()) / 1e18;
        pairOut = _amountOut(quoteIn, rQuote, rToken);
        uint256 before = LaunchToken(token).balanceOf(carol);
        vm.prank(carol);
        got = zap.zapPoolBuy{value: ethIn}(token, _in(), 0, 0);
        assertEq(got, LaunchToken(token).balanceOf(carol) - before, "the call returns what the caller received");
    }

    // ---------------------------------------------------------------- tests

    function test_anEthBuyLandsTheCoinsOnTheCaller() public {
        uint256 tT = pad.taxTreasury(token);
        uint256 tP = pad.taxPot(token);
        uint256 quoteIn = (0.1 ether * dex.RATE()) / 1e18;
        (uint256 rToken, uint256 rQuote) = _reserves();
        uint256 pairOut = _amountOut(quoteIn, rQuote, rToken);
        uint256 tax = (pairOut * RATE_BPS) / 10_000;

        vm.expectEmit(true, true, true, true, address(zap));
        emit ZapRouter.ZappedPoolBuy(token, carol, 0.1 ether, quoteIn, pairOut - tax);
        (, uint256 got) = _buy(0.1 ether);

        assertEq(got, pairOut - tax, "the pair's output less the coin's charge");
        assertEq(carol.balance, 10 ether - 0.1 ether, "the ETH spent, nothing more");
        // the charge is in the pad's buckets, the launchpad's part by its rate
        uint256 platform = (tax * 50) / RATE_BPS;
        assertEq(pad.taxTreasury(token) - tT, platform, "the launchpad's bucket");
        assertEq(pad.taxPot(token) - tP, tax - platform, "the coin's bucket");
        _zapIsEmpty();
    }

    function test_aSaleForEthPaysTheCaller() public {
        (, uint256 got) = _buy(0.1 ether);
        (uint256 rToken, uint256 rQuote) = _reserves();
        uint256 tax = (got * RATE_BPS) / 10_000;
        uint256 quoteOut = _amountOut(got - tax, rToken, rQuote);
        uint256 ethOut = (quoteOut * 1e18) / dex.RATE();
        uint256 tT = pad.taxTreasury(token);
        uint256 before = carol.balance;

        vm.startPrank(carol);
        LaunchToken(token).approve(address(zap), got);
        vm.expectEmit(true, true, true, true, address(zap));
        emit ZapRouter.ZappedPoolSell(token, carol, got, quoteOut, ethOut);
        uint256 paid = zap.zapPoolSell(token, got, _out(), 0, 0);
        vm.stopPrank();

        assertEq(paid, ethOut, "the call returns the ETH paid");
        assertEq(carol.balance - before, ethOut, "the ETH is the caller's");
        assertEq(LaunchToken(token).balanceOf(carol), 0, "every coin sold");
        assertLt(ethOut, 0.1 ether, "a round trip costs the charges and the pool's move");
        assertGt(ethOut, 0.09 ether, "and not more than a few percent");
        assertEq(pad.taxTreasury(token) - tT, (tax * 50) / RATE_BPS, "the sale's charge, the launchpad's part");
        _zapIsEmpty();
    }

    function test_theBuyChecksEachLegsMinimum() public {
        uint256 quoteIn = (0.1 ether * dex.RATE()) / 1e18;
        vm.startPrank(carol);
        vm.expectRevert(bytes("Too little received"));
        zap.zapPoolBuy{value: 0.1 ether}(token, _in(), quoteIn + 1, 0);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        zap.zapPoolBuy{value: 0.1 ether}(token, _in(), quoteIn, type(uint256).max);
        vm.expectRevert(ZapRouter.ZeroAmount.selector);
        zap.zapPoolBuy{value: 0}(token, _in(), 0, 0);
        vm.stopPrank();
        _zapIsEmpty();
    }

    function test_theSaleChecksEachLegsMinimum() public {
        (, uint256 got) = _buy(0.1 ether);
        vm.startPrank(carol);
        LaunchToken(token).approve(address(zap), got);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        zap.zapPoolSell(token, got, _out(), type(uint256).max, 0);
        vm.expectRevert(bytes("Too little received"));
        zap.zapPoolSell(token, got, _out(), 0, type(uint256).max);
        vm.expectRevert(ZapRouter.ZeroAmount.selector);
        zap.zapPoolSell(token, 0, _out(), 0, 0);
        vm.stopPrank();
        assertEq(LaunchToken(token).balanceOf(carol), got, "nothing sold");
        _zapIsEmpty();
    }

    function test_thePathsMustMeetTheLegs() public {
        vm.startPrank(carol);
        // a buy path has to start at WETH and end at the coin's quote
        vm.expectRevert(ZapRouter.PathMismatch.selector);
        zap.zapPoolBuy{value: 0.1 ether}(token, _out(), 0, 0);
        vm.expectRevert(ZapRouter.PathMismatch.selector);
        zap.zapPoolBuy{value: 0.1 ether}(token, abi.encodePacked(address(weth), uint24(200), token), 0, 0);
        // a sale path the other way round
        vm.expectRevert(ZapRouter.PathMismatch.selector);
        zap.zapPoolSell(token, 1, _in(), 0, 0);
        vm.expectRevert(ZapRouter.PathMismatch.selector);
        zap.zapPoolSell(token, 1, abi.encodePacked(address(cb)), 0, 0);
        vm.stopPrank();
    }

    function test_aCoinOnItsCurveHasNoPool() public {
        vm.prank(alice);
        address young = pad.createTokenWithFees("Young", "YNG", 0, meta, address(cb), notus);
        vm.startPrank(carol);
        vm.expectRevert(ZapRouter.NoPool.selector);
        zap.zapPoolBuy{value: 0.1 ether}(young, _in(), 0, 0);
        vm.expectRevert(ZapRouter.NoPool.selector);
        zap.zapPoolSell(young, 1, _out(), 0, 0);
        // the curve leg still serves it
        zap.zapBuy{value: 0.1 ether}(young, _in(), 0, 0);
        vm.stopPrank();
        assertGt(LaunchToken(young).balanceOf(carol), 0, "bought on the curve with ETH");
        assertEq(cb.balanceOf(address(zap)), 0, "nothing left in the zap");
    }

    function test_aNativeCurveIsNotAZapsBusiness() public {
        vm.prank(alice);
        address eth = pad.createTokenWithFees("Native", "NAT", 0, meta, address(0), notus);
        vm.startPrank(carol);
        vm.expectRevert(ZapRouter.NotQuoteCurve.selector);
        zap.zapPoolBuy{value: 0.1 ether}(eth, _in(), 0, 0);
        vm.expectRevert(ZapRouter.NotQuoteCurve.selector);
        zap.zapPoolSell(eth, 1, _out(), 0, 0);
        vm.stopPrank();
    }
}
