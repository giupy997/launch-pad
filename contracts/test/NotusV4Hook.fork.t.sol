// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {NotusV4Hook} from "../src/NotusV4Hook.sol";
import {HookMiner} from "../script/HookMiner.sol";

/// Minimal v4 swap executor: holds its own funds, pays what it owes and
/// takes what it is owed.
contract V4Swapper is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    function swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified) external returns (BalanceDelta) {
        return abi.decode(pm.unlock(abi.encode(key, zeroForOne, amountSpecified)), (BalanceDelta));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (PoolKey memory key, bool zeroForOne, int256 amountSpecified) = abi.decode(data, (PoolKey, bool, int256));
        BalanceDelta d = pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        _resolve(key.currency0, d.amount0());
        _resolve(key.currency1, d.amount1());
        return abi.encode(d);
    }

    function _resolve(Currency c, int128 amount) internal {
        if (amount < 0) {
            uint256 owed = uint256(int256(-amount));
            if (c.isAddressZero()) {
                pm.settle{value: owed}();
            } else {
                pm.sync(c);
                IERC20(Currency.unwrap(c)).transfer(address(pm), owed);
                pm.settle();
            }
        } else if (amount > 0) {
            pm.take(c, address(this), uint256(int256(amount)));
        }
    }
}

interface IV4QuoterLike {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

interface IUniversalRouterLike {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// Graduation into Uniswap v4 and the fee hook, against the REAL PoolManager,
/// Quoter and Universal Router on Robinhood Chain mainnet (fork simulation —
/// no real funds). Run with: RUN_FORK=true forge test --match-contract NotusV4Hook -vv
contract NotusV4HookForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address constant QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    uint256 constant CURVE_SUPPLY = 800_000_000e18;

    Launchpad pad;
    NotusV4Hook hook;
    V4Swapper swapper;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creator
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    bool skipAll;

    function setUp() public {
        if (!vm.envOr("RUN_FORK", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");

        pad = new Launchpad(treasury, address(PM));
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address expected, bytes32 salt) =
            HookMiner.find(address(this), flags, type(NotusV4Hook).creationCode, abi.encode(PM, address(pad)));
        hook = new NotusV4Hook{salt: salt}(PM, address(pad));
        assertEq(address(hook), expected, "mined address");
        pad.setMigrator(address(hook));
        pad.authorizePoolFeeHook(address(hook));

        swapper = new V4Swapper(PM);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(address(swapper), 100 ether);
    }

    // ------------------------------------------------------------ helpers

    function _meta() internal pure returns (Launchpad.TokenMetadata memory) {
        return Launchpad.TokenMetadata("", "", "", "", "", "");
    }

    function _key(address token) internal view returns (PoolKey memory key) {
        (Currency c0, Currency c1, uint24 fee, int24 spacing, IHooks hooks) = hook.poolKeys(token);
        key = PoolKey(c0, c1, fee, spacing, hooks);
    }

    function _graduateEth(bool toHolders) internal returns (address token) {
        vm.prank(alice);
        token = pad.createToken("Hooked", "HOOK", 0, _meta(), address(0), toHolders);
        vm.prank(carol);
        pad.buy{value: 1 ether}(token, 0);
        vm.prank(bob);
        pad.buy{value: 50 ether}(token, 0); // crosses graduation: auto-migrates into v4
    }

    /// The fee the hook took during the last swap (from its event).
    function _swapFee(Vm.Log[] memory logs) internal view returns (uint256 total) {
        bytes32 sig = keccak256("SwapFeeTaken(address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(hook) && logs[i].topics[0] == sig) total += abi.decode(logs[i].data, (uint256));
        }
    }

    function _assertSupplyInvariant(address token) internal view {
        uint256 outside = IERC20(token).totalSupply() - IERC20(token).balanceOf(address(pad))
            - IERC20(token).balanceOf(address(PM));
        assertEq(pad.eligibleSupply(token), outside, "eligible supply == tokens outside launchpad and pool");
    }

    // -------------------------------------------------------------- tests

    function test_graduationSeedsLockedV4Pool() public {
        if (skipAll) return;
        address token = _graduateEth(true);

        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "graduated");
        assertEq(realEth, 0, "curve ETH moved into the pool");

        PoolKey memory key = _key(token);
        assertEq(Currency.unwrap(key.currency0), address(0), "native ETH, no WETH");
        assertEq(Currency.unwrap(key.currency1), token);
        assertEq(key.fee, 0, "pool charges nothing, the hook charges");
        (uint160 sqrtPriceX96,,,) = PM.getSlot0(key.toId());
        assertGt(sqrtPriceX96, 0, "pool initialized");
        assertGt(PM.getLiquidity(key.toId()), 0, "liquidity in range");
        assertGt(IERC20(token).balanceOf(address(PM)), 199_000_000e18, "DEX reserve in the pool");

        assertEq(address(hook).balance, 0, "hook keeps no ETH");
        assertEq(IERC20(token).balanceOf(address(hook)), 0, "hook keeps no tokens");
        _assertSupplyInvariant(token);

        // nobody else can create pools bound to the hook
        PoolKey memory rogue = PoolKey(Currency.wrap(address(0)), Currency.wrap(token), 3000, 60, IHooks(address(hook)));
        vm.expectRevert();
        PM.initialize(rogue, sqrtPriceX96);
    }

    function test_holdersKeepEarningAfterGraduation_allSwapModes() public {
        if (skipAll) return;
        address token = _graduateEth(true);
        PoolKey memory key = _key(token);

        uint256 bobCashback0 = pad.cashbackOf(token, bob);
        uint256 treasury0 = pad.creatorFees(treasury, address(0));

        // one statement per swap: Solidity does not guarantee operand order,
        // and the sells need the tokens the buys deliver
        uint256 fees = _exactInBuy(key);
        fees += _exactOutBuy(key);
        fees += _exactInSell(key, token);
        fees += _exactOutSell(key);

        // every fee was split 20% treasury / 80% holders, none to the creator
        uint256 toTreasury = pad.creatorFees(treasury, address(0)) - treasury0;
        assertApproxEqAbs(toTreasury, fees / 5, 4, "20% treasury");
        assertEq(pad.creatorFees(alice, address(0)), 0, "holders mode: nothing to the creator");
        assertGt(pad.cashbackOf(token, bob), bobCashback0, "bob keeps earning after graduation");

        _assertSupplyInvariant(token);
        _assertSolventAndClaimable(token);
    }

    /// exact-input buy: pay exactly 1 ETH, fee = 1% of it
    function _exactInBuy(PoolKey memory key) internal returns (uint256 fee) {
        uint256 ethBefore = address(swapper).balance;
        vm.recordLogs();
        swapper.swap(key, true, -1 ether);
        fee = _swapFee(vm.getRecordedLogs());
        assertEq(fee, 0.01 ether, "exact-in buy fee");
        assertEq(ethBefore - address(swapper).balance, 1 ether, "paid exactly the input");
    }

    /// exact-output buy: fee is 1% of the gross ETH paid
    function _exactOutBuy(PoolKey memory key) internal returns (uint256 fee) {
        uint256 ethBefore = address(swapper).balance;
        vm.recordLogs();
        swapper.swap(key, true, int256(2_000_000e18));
        fee = _swapFee(vm.getRecordedLogs());
        uint256 paid = ethBefore - address(swapper).balance;
        assertGt(fee, 0);
        assertEq(fee, ((paid - fee) * 100) / 9_900, "exact-out buy fee");
    }

    /// exact-input sell: fee out of the gross ETH out
    function _exactInSell(PoolKey memory key, address token) internal returns (uint256 fee) {
        uint256 sellAmount = IERC20(token).balanceOf(address(swapper)) / 2;
        uint256 ethBefore = address(swapper).balance;
        vm.recordLogs();
        swapper.swap(key, false, -int256(sellAmount));
        fee = _swapFee(vm.getRecordedLogs());
        uint256 received = address(swapper).balance - ethBefore;
        assertGt(fee, 0);
        assertEq(fee, ((received + fee) * 100) / 10_000, "exact-in sell fee");
    }

    /// exact-output sell: receive exactly 0.1 ETH, fee on top
    function _exactOutSell(PoolKey memory key) internal returns (uint256 fee) {
        uint256 ethBefore = address(swapper).balance;
        vm.recordLogs();
        swapper.swap(key, false, int256(0.1 ether));
        fee = _swapFee(vm.getRecordedLogs());
        assertEq(address(swapper).balance - ethBefore, 0.1 ether, "received exactly the output");
        assertEq(fee, (uint256(0.1 ether) * 100) / 9_900, "exact-out sell fee");
    }

    /// Everything anyone can claim is backed by ETH the launchpad holds, and
    /// the claims actually pay out.
    function _assertSolventAndClaimable(address token) internal {
        address[5] memory holders = [bob, carol, address(swapper), treasury, alice];
        uint256 owed = pad.creatorFees(treasury, address(0));
        for (uint256 i = 0; i < holders.length; i++) {
            owed += pad.cashbackOf(token, holders[i]);
        }
        assertLe(owed, address(pad).balance, "solvent");

        uint256 bobEth = bob.balance;
        vm.prank(bob);
        pad.claimCashback(token);
        assertGt(bob.balance, bobEth, "bob claimed post-graduation rewards");
        vm.prank(treasury);
        pad.claimCreatorFees(address(0));
    }

    function test_creatorModeFeesGoToCreatorAfterGraduation() public {
        if (skipAll) return;
        address token = _graduateEth(false);
        PoolKey memory key = _key(token);

        uint256 creator0 = pad.creatorFees(alice, address(0));
        uint256 bob0 = pad.cashbackOf(token, bob);
        swapper.swap(key, true, -1 ether);
        assertEq(pad.creatorFees(alice, address(0)) - creator0, 0.008 ether, "80% of the 0.01 ETH fee");
        assertEq(pad.cashbackOf(token, bob), bob0, "no holder rewards in creator mode");
    }

    function test_selfTransferAfterGraduationCannotInflate() public {
        if (skipAll) return;
        address token = _graduateEth(true);
        swapper.swap(_key(token), true, -1 ether); // accrue some pool fees

        uint256 honest = pad.cashbackOf(token, bob);
        uint256 bal = IERC20(token).balanceOf(bob);
        vm.startPrank(bob);
        for (uint256 i = 0; i < 10; i++) IERC20(token).transfer(bob, bal);
        vm.stopPrank();
        assertEq(pad.cashbackOf(token, bob), honest);
    }

    function test_preMarketQuotedPool_erc20Path() public {
        if (skipAll) return;
        // a pre-market quote is itself a LaunchToken in holders mode: this is
        // the ERC-20 path plus nested cashback accounting on the quote
        address pre = pad.createPreMarket("OpenAI Pre-Market", "OPENAI", _meta(), 50_000_000e18);
        vm.prank(bob);
        pad.buy{value: 2 ether}(pre, 0);

        vm.prank(alice);
        address token = pad.createToken("OpenAI Fan", "OFAN", 0, _meta(), pre, true);
        vm.startPrank(bob);
        IERC20(pre).approve(address(pad), type(uint256).max);
        pad.buyWithQuote(token, 400_000_000e18, 0); // crosses graduation
        IERC20(pre).transfer(address(swapper), 20_000_000e18);
        vm.stopPrank();

        (,,,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "paired token graduated");
        PoolKey memory key = _key(token);
        bool preIs0 = Currency.unwrap(key.currency0) == pre;

        uint256 treasury0 = pad.creatorFees(treasury, pre);
        uint256 bob0 = pad.cashbackOf(token, bob);
        uint256 preBefore = IERC20(pre).balanceOf(address(swapper));
        vm.recordLogs();
        swapper.swap(key, preIs0, -int256(10_000_000e18)); // exact-input buy paying the pre-market
        uint256 fee = _swapFee(vm.getRecordedLogs());

        assertEq(fee, 100_000e18, "1% of 10M pre-market");
        assertEq(preBefore - IERC20(pre).balanceOf(address(swapper)), 10_000_000e18, "paid exactly the input");
        assertEq(pad.creatorFees(treasury, pre) - treasury0, 20_000e18, "20% treasury, in the pre-market");
        assertGt(pad.cashbackOf(token, bob), bob0, "holders paid in the pre-market");
        assertEq(IERC20(pre).balanceOf(address(hook)), 0, "hook keeps no quote");

        _assertSupplyInvariant(token);
        _assertSupplyInvariant(pre);
    }

    function test_realStockQuotedPool_nvda() public {
        if (skipAll) return;
        // the official Robinhood NVDA token (a proxy), not a mock
        address nvda = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
        pad.setQuoteAsset(nvda, 20e18);
        deal(nvda, bob, 200e18);
        deal(nvda, address(swapper), 20e18);
        assertEq(IERC20(nvda).balanceOf(bob), 200e18, "dealt real NVDA");

        vm.prank(alice);
        address token = pad.createToken("Nvidia Fan", "NFAN", 0, _meta(), nvda, true);
        vm.startPrank(bob);
        IERC20(nvda).approve(address(pad), type(uint256).max);
        pad.buyWithQuote(token, 150e18, 0); // crosses graduation (~64 NVDA raise)
        vm.stopPrank();

        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "graduated");
        assertEq(realEth, 0, "NVDA moved into the v4 pool");

        PoolKey memory key = _key(token);
        bool nvdaIs0 = Currency.unwrap(key.currency0) == nvda;
        uint256 treasury0 = pad.creatorFees(treasury, nvda);
        vm.recordLogs();
        swapper.swap(key, nvdaIs0, -int256(10e18));
        uint256 fee = _swapFee(vm.getRecordedLogs());

        assertEq(fee, 0.1e18, "1% of 10 NVDA");
        assertEq(pad.creatorFees(treasury, nvda) - treasury0, 0.02e18, "20% treasury in NVDA");
        assertEq(IERC20(nvda).balanceOf(address(hook)), 0, "hook keeps no NVDA");
        _assertSupplyInvariant(token);
    }

    function test_quoterPricesSwapsThroughTheHook() public {
        if (skipAll) return;
        address token = _graduateEth(true);
        PoolKey memory key = _key(token);

        (uint256 quoted,) = IV4QuoterLike(QUOTER).quoteExactInputSingle(
            IV4QuoterLike.QuoteExactSingleParams({poolKey: key, zeroForOne: true, exactAmount: 0.5 ether, hookData: ""})
        );
        uint256 before = IERC20(token).balanceOf(address(swapper));
        swapper.swap(key, true, -0.5 ether);
        assertEq(IERC20(token).balanceOf(address(swapper)) - before, quoted, "quote == execution, fee included");
    }

    struct ExactInSingleV40 {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    struct ExactInSingleLatest {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    function test_universalRouterBuysThroughTheHook() public {
        if (skipAll) return;
        address token = _graduateEth(true);
        PoolKey memory key = _key(token);
        address dave = makeAddr("dave");
        vm.deal(dave, 1 ether);

        bytes memory commands = abi.encodePacked(uint8(0x10)); // V4_SWAP
        bytes memory actions = abi.encodePacked(uint8(0x06), uint8(0x0c), uint8(0x0f)); // exact-in single, settle all, take all
        bytes[] memory params = new bytes[](3);
        params[1] = abi.encode(key.currency0, uint256(0.5 ether));
        params[2] = abi.encode(key.currency1, uint256(0));

        // the deployed router may predate or include minHopPriceX36
        params[0] = abi.encode(ExactInSingleV40(key, true, 0.5 ether, 0, ""));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        vm.recordLogs();
        vm.prank(dave);
        (bool ok,) = ROUTER.call{value: 0.5 ether}(
            abi.encodeCall(IUniversalRouterLike.execute, (commands, inputs, block.timestamp))
        );
        if (!ok) {
            params[0] = abi.encode(ExactInSingleLatest(key, true, 0.5 ether, 0, 0, ""));
            inputs[0] = abi.encode(actions, params);
            vm.prank(dave);
            IUniversalRouterLike(ROUTER).execute{value: 0.5 ether}(commands, inputs, block.timestamp);
        }

        assertGt(IERC20(token).balanceOf(dave), 0, "dave bought through the Uniswap router");
        assertEq(_swapFee(vm.getRecordedLogs()), 0.005 ether, "hook fee charged on router swaps too");
    }
}
