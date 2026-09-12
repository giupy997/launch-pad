// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV3Migrator} from "../src/UniV3Migrator.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";

interface IUniV3FactoryView {
    function getPool(address, address, uint24) external view returns (address);
}

/// End-to-end graduation check against the PRODUCTION contracts deployed on
/// Robinhood Chain mainnet (fork simulation — no real funds spent).
/// NOTE: targets the deployed production addresses — update PAD/MIG after
/// each redeploy. Run with: RUN_FORK_LIVE=true forge test --match-contract LiveGraduation -vv
contract LiveGraduationForkTest is Test {
    Launchpad constant PAD = Launchpad(0xD5d932C0A1418Bc0976D1a2D733F8e363746A4bC);
    UniV3Migrator constant MIG = UniV3Migrator(0x5e81b8c1E89283d19DC7Ab8e6600565224ab8940);
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    bool skipAll;
    address whale = makeAddr("whale");

    function setUp() public {
        if (!vm.envOr("RUN_FORK_LIVE", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        vm.deal(whale, 100 ether);
    }

    function test_liveContracts_graduationAutoMigrates() public {
        if (skipAll) return;

        // wiring sanity on the real deployment
        assertEq(address(PAD.migrator()), address(MIG), "migrator wired");
        assertEq(MIG.launchpad(), address(PAD), "migrator points back");
        // v7.2: creator+cashback bps form one 80% pot, all-creator or all-holders
        assertEq(PAD.creatorFeeShareBps() + PAD.holderCashbackBps(), 8_000, "80% pot");

        // launch in holders-rewards mode + buy through graduation, like a real user
        vm.startPrank(whale);
        address token = PAD.createToken(
            "Dry Run", "DRY", 0,
            Launchpad.TokenMetadata("", "", "", "", "", "graduation dry run"), address(0), true
        );
        PAD.buy{value: 50 ether}(token, 0);
        vm.stopPrank();

        (,, uint256 realEth, uint256 sold, bool graduated,,) = PAD.curves(token);
        assertTrue(graduated, "graduated");
        assertEq(sold, PAD.CURVE_SUPPLY(), "curve sold out");
        assertEq(realEth, 0, "curve ETH fully migrated");

        // the Uniswap v3 pool exists, holds the liquidity, position locked
        address pool = IUniV3FactoryView(FACTORY).getPool(token, WETH, 10_000);
        assertTrue(pool != address(0), "pool created");
        assertGt(MIG.positions(token), 0, "LP NFT locked in migrator");
        assertGt(IERC20(WETH).balanceOf(pool), 3.9 ether, "~4 ETH in pool");
        assertGt(IERC20(token).balanceOf(pool), 190_000_000e18, "DEX reserve in pool");

        // fee plumbing worked along the way (rewards mode: the whole pot is cashback)
        assertTrue(PAD.feesToHolders(token), "rewards mode stored");
        assertEq(PAD.creatorFees(whale, address(0)), 0, "no creator fees in rewards mode");
        assertGt(PAD.cashbackOf(token, whale), 0, "holder cashback accrued");

        // LP fee collection callable
        MIG.collectFees(token);
    }
}
