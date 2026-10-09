// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV3Migrator} from "../src/UniV3Migrator.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin-contracts/contracts/token/ERC20/ERC20.sol";

contract ForkMockUSD is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface IUniV3FactoryView {
    function getPool(address, address, uint24) external view returns (address);
}

/// Fork test against the real Uniswap v3 deployment on Robinhood Chain.
/// Run explicitly with:
///   RUN_FORK=true forge test --match-contract UniV3MigratorFork -vv
contract UniV3MigratorForkTest is Test {
    address constant NPM = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    bool skipAll;
    Launchpad pad;
    UniV3Migrator mig;
    address treasury = makeAddr("treasury");
    address whale = makeAddr("whale");

    function setUp() public {
        if (!vm.envOr("RUN_FORK", false)) {
            skipAll = true;
            return;
        }
        vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com");
        pad = new Launchpad(treasury);
        mig = new UniV3Migrator(address(pad), NPM, WETH);
        pad.setMigrator(address(mig));
        vm.deal(whale, 100 ether);
    }

    function test_fork_migrateCreatesLockedPool() public {
        if (skipAll) return;

        vm.startPrank(whale);
        address token = pad.createToken(
            "Fork Test", "FORK", 0,
            Launchpad.TokenMetadata("", "", "", "", "", ""), address(0), false
        );
        pad.buy{value: 50 ether}(token, 0); // crosses graduation, surplus refunded
        vm.stopPrank();

        (,,, uint256 sold, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(sold, pad.CURVE_SUPPLY());

        // auto-migration ran inside the graduating buy
        // pool exists at the 1% tier and the position is locked in the migrator
        address pool = IUniV3FactoryView(FACTORY).getPool(token, WETH, 10_000);
        assertTrue(pool != address(0));
        assertGt(mig.positions(token), 0);

        // pool actually holds the liquidity
        assertGt(IERC20(token).balanceOf(pool), 0);
        assertGt(IERC20(WETH).balanceOf(pool), 3.9 ether);

        // launchpad kept nothing of the curve ETH for this token
        (,, uint256 realEthAfter,,,,) = pad.curves(token);
        assertEq(realEthAfter, 0);
        vm.expectRevert(Launchpad.ZeroAmount.selector);
        pad.migrate(token); // nothing left for the manual path

        // collect works even with zero fees accrued
        mig.collectFees(token);
    }

    function test_fork_quoteCurveMigratesToAssetPool() public {
        if (skipAll) return;

        ForkMockUSD usd = new ForkMockUSD();
        pad.setQuoteAsset(address(usd), 4_000e6);
        usd.mint(whale, 1_000_000e6);

        vm.startPrank(whale);
        usd.approve(address(pad), type(uint256).max);
        address token = pad.createToken(
            "Stock Pair", "SPX", 0,
            Launchpad.TokenMetadata("", "", "", "", "", ""), address(usd), false
        );
        pad.buyWithQuote(token, 100_000e6, 0); // crosses graduation
        vm.stopPrank();

        (,,, uint256 sold, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(sold, pad.CURVE_SUPPLY());

        // real Uniswap v3 pool paired against the quote asset
        address pool = IUniV3FactoryView(FACTORY).getPool(token, address(usd), 10_000);
        assertTrue(pool != address(0), "token/quote pool created");
        assertGt(mig.positions(token), 0, "position locked");
        assertGt(usd.balanceOf(pool), 12_000e6, "quote liquidity in pool");
        assertGt(IERC20(token).balanceOf(pool), 190_000_000e18, "token liquidity in pool");

        mig.collectFees(token);
    }
}
