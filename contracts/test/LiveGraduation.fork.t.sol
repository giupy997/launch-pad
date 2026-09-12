// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {NotusV4Hook} from "../src/NotusV4Hook.sol";
import {V4Swapper} from "./NotusV4Hook.fork.t.sol";

/// End-to-end graduation against the PRODUCTION contracts deployed on
/// Robinhood Chain mainnet (fork simulation — no real funds spent): launch in
/// holders mode, buy through graduation into the Uniswap v4 pool, trade in
/// the pool, and check the holders keep earning.
/// NOTE: targets the deployed addresses — update PAD/HOOK after each redeploy.
/// Run with: RUN_FORK_LIVE=true forge test --match-contract LiveGraduation -vv
contract LiveGraduationForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    Launchpad constant PAD = Launchpad(0x4A84c7B0dc45a473eA67f56617BC5903CA2c001c);
    NotusV4Hook constant HOOK = NotusV4Hook(payable(0x11E98A9d691B8730990d9bE1da9CD012f4e320cC));
    IPoolManager constant PM = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    bool skipAll;
    address creator = makeAddr("creator");
    address whale = makeAddr("whale");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        vm.deal(whale, 100 ether);
    }

    function test_liveContracts_graduateIntoV4AndHoldersKeepEarning() public {
        if (skipAll) return;

        // wiring on the real deployment
        assertEq(address(PAD.migrator()), address(HOOK), "hook is the migrator");
        assertTrue(PAD.isPoolFeeHook(address(HOOK)), "hook may deposit pool fees");
        assertEq(PAD.poolManager(), address(PM), "v4 pool reserves excluded from cashback");
        assertEq(HOOK.launchpad(), address(PAD), "hook points back");

        vm.prank(creator);
        address token = PAD.createToken(
            "Dry Run", "DRY", 0, Launchpad.TokenMetadata("", "", "", "", "", "graduation dry run"), address(0), true
        );
        vm.prank(whale);
        PAD.buy{value: 50 ether}(token, 0);

        (,, uint256 realEth,, bool graduated,,) = PAD.curves(token);
        assertTrue(graduated, "graduated");
        assertEq(realEth, 0, "curve ETH moved into the pool");

        (Currency c0, Currency c1, uint24 fee, int24 spacing, IHooks hooks) = HOOK.poolKeys(token);
        PoolKey memory key = PoolKey(c0, c1, fee, spacing, hooks);
        assertGt(PM.getLiquidity(key.toId()), 0, "locked liquidity in the v4 pool");

        // trade in the pool: the whale's holdings keep earning cashback
        uint256 before = PAD.cashbackOf(token, whale);
        V4Swapper swapper = new V4Swapper(PM);
        vm.deal(address(swapper), 5 ether);
        swapper.swap(key, true, -1 ether);
        assertGt(PAD.cashbackOf(token, whale), before, "holder rewards continue after graduation");
        assertEq(PAD.creatorFees(creator, address(0)), 0, "holders mode: nothing to the creator");

        uint256 whaleEth = whale.balance;
        vm.prank(whale);
        PAD.claimCashback(token);
        assertGt(whale.balance, whaleEth, "claim pays out");
    }
}
