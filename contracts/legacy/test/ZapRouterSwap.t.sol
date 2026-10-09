// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {ZapRouter, ISwapRouter02} from "../src/ZapRouter.sol";
import {SlipstreamZapRouter, ISlipstreamRouter} from "../src/SlipstreamZapRouter.sol";
import {IDexMigrator} from "../src/interfaces/IDexMigrator.sol";

contract NoopMigrator is IDexMigrator {
    function migrate(address, uint256, address, uint256) external payable {}
}

contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}

/// A quote asset with cbLTC's eight decimals.
contract MockQuote is ERC20 {
    constructor() ERC20("Coinbase Wrapped LTC", "cbLTC") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// What both mock routers do with a swap: take the WETH, hand out quote at a
/// fixed 40 quote per WETH (eight decimals), honour the minimum, remember the call.
abstract contract RecordingRouter {
    MockWETH public immutable weth;
    MockQuote public immutable quote;
    bytes public lastPath;
    address public lastRecipient;
    uint256 public lastAmountIn;
    uint256 public lastMinOut;
    uint256 public calls;

    constructor(MockWETH weth_, MockQuote quote_) {
        weth = weth_;
        quote = quote_;
    }

    function _fill(bytes calldata path, address recipient, uint256 amountIn, uint256 minOut) internal returns (uint256 out) {
        IERC20(address(weth)).transferFrom(msg.sender, address(this), amountIn);
        out = amountIn * 40 / 1e10;
        require(out >= minOut, "Too little received");
        quote.mint(recipient, out);
        lastPath = path;
        lastRecipient = recipient;
        lastAmountIn = amountIn;
        lastMinOut = minOut;
        calls++;
    }
}

/// SwapRouter02 (Uniswap, PancakeSwap SmartRouter): no deadline in the struct.
contract Mock02Router is RecordingRouter {
    constructor(MockWETH w, MockQuote q) RecordingRouter(w, q) {}

    function exactInput(ISwapRouter02.ExactInputParams calldata p) external payable returns (uint256) {
        return _fill(p.path, p.recipient, p.amountIn, p.amountOutMinimum);
    }
}

/// Aerodrome Slipstream: Uniswap's v3 SwapRouter shape, deadline third.
contract MockSlipstreamRouter is RecordingRouter {
    uint256 public lastDeadline;

    constructor(MockWETH w, MockQuote q) RecordingRouter(w, q) {}

    function exactInput(ISlipstreamRouter.ExactInputParams calldata p) external payable returns (uint256) {
        require(block.timestamp <= p.deadline, "Transaction too old");
        lastDeadline = p.deadline;
        return _fill(p.path, p.recipient, p.amountIn, p.amountOutMinimum);
    }
}

/// The DEX leg of zapBuy, on both router shapes, against a real Launchpad
/// with an eight-decimal quote asset.
contract ZapRouterSwapTest is Test {
    Launchpad pad;
    MockWETH weth;
    MockQuote quote;
    Mock02Router r02;
    MockSlipstreamRouter rSlip;
    ZapRouter zap02;
    SlipstreamZapRouter zapSlip;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address token;

    function setUp() public {
        pad = new Launchpad(treasury);
        pad.setMigrator(address(new NoopMigrator()));
        weth = new MockWETH();
        quote = new MockQuote();
        pad.setQuoteAsset(address(quote), 30e8); // 30 cbLTC virtual, as on Base
        r02 = new Mock02Router(weth, quote);
        rSlip = new MockSlipstreamRouter(weth, quote);
        zap02 = new ZapRouter(address(pad), address(r02), address(weth));
        zapSlip = new SlipstreamZapRouter(address(pad), address(rSlip), address(weth));
        vm.prank(alice);
        token = pad.createToken("Notus Cat", "NCAT", 0, Launchpad.TokenMetadata("", "", "", "", "", ""), address(quote), false);
        vm.deal(bob, 10 ether);
        vm.warp(1_790_000_000);
    }

    function _path(uint24 hop) internal view returns (bytes memory) {
        return abi.encodePacked(address(weth), hop, address(quote));
    }

    function test_zapBuyThroughSwapRouter02() public {
        vm.prank(bob);
        zap02.zapBuy{value: 0.01 ether}(token, _path(500), 0.39e8, 0);
        assertEq(r02.calls(), 1);
        assertEq(r02.lastPath(), _path(500));
        assertEq(r02.lastRecipient(), address(zap02), "the quote lands on the zap, which buys with it");
        assertEq(r02.lastAmountIn(), 0.01 ether);
        assertEq(r02.lastMinOut(), 0.39e8);
        assertGt(LaunchToken(token).balanceOf(bob), 0, "bob holds the coin");
        assertEq(quote.balanceOf(address(zap02)), 0, "nothing stranded on the zap");
        (,, uint256 realQuote,,,,) = pad.curves(token);
        assertEq(realQuote, 0.396e8, "the curve holds the swapped quote, less the 1% trade fee");
    }

    function test_zapBuyThroughSlipstream() public {
        vm.prank(bob);
        zapSlip.zapBuy{value: 0.01 ether}(token, _path(200), 0.39e8, 0);
        assertEq(rSlip.calls(), 1);
        assertEq(rSlip.lastPath(), _path(200), "a tick spacing travels in the fee slot: same three bytes");
        assertEq(rSlip.lastDeadline(), block.timestamp, "the deadline is the block itself");
        assertEq(rSlip.lastRecipient(), address(zapSlip));
        assertGt(LaunchToken(token).balanceOf(bob), 0);
        assertEq(quote.balanceOf(address(zapSlip)), 0);
    }

    /// Each zap speaks one router shape: pointed at the other, the call reverts
    /// instead of silently doing something else.
    function test_shapesDoNotMix() public {
        ZapRouter wrong02 = new ZapRouter(address(pad), address(rSlip), address(weth));
        vm.prank(bob);
        vm.expectRevert();
        wrong02.zapBuy{value: 0.01 ether}(token, _path(200), 0, 0);

        SlipstreamZapRouter wrongSlip = new SlipstreamZapRouter(address(pad), address(r02), address(weth));
        vm.prank(bob);
        vm.expectRevert();
        wrongSlip.zapBuy{value: 0.01 ether}(token, _path(500), 0, 0);
    }

    function test_slippageGuardOnTheSwap() public {
        vm.prank(bob);
        vm.expectRevert(bytes("Too little received"));
        zapSlip.zapBuy{value: 0.01 ether}(token, _path(200), 0.41e8, 0);
    }

    function test_pathMustRunFromWethToTheQuote() public {
        bytes memory fromElsewhere = abi.encodePacked(address(quote), uint24(200), address(quote));
        vm.prank(bob);
        vm.expectRevert(ZapRouter.PathMismatch.selector);
        zapSlip.zapBuy{value: 0.01 ether}(token, fromElsewhere, 0, 0);

        bytes memory toElsewhere = abi.encodePacked(address(weth), uint24(200), address(weth));
        vm.prank(bob);
        vm.expectRevert(ZapRouter.PathMismatch.selector);
        zapSlip.zapBuy{value: 0.01 ether}(token, toElsewhere, 0, 0);
    }
}
