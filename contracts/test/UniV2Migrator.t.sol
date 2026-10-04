// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {MockWETH9, MockV2Factory, MockV2Pair, MockV2Router} from "./mocks/UniV2Mock.sol";

/// The graduation adapter against a Uniswap v2 pool that anyone may have
/// touched first: the reserve reaches the pool at the curve's price, or waits,
/// and never meets a price somebody else set.
contract UniV2MigratorTest is Test {
    Launchpad pad;
    MockWETH9 weth;
    MockV2Factory factory;
    UniV2Migrator migrator;
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address buyer = makeAddr("buyer");
    address griefer = makeAddr("griefer");

    function setUp() public {
        pad = new Launchpad(treasury);
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        vm.deal(buyer, 500 ether);
        vm.deal(griefer, 500 ether);
    }

    function _create() internal returns (address) {
        vm.prank(creator);
        return pad.createToken("Meme", "MEME", 0, Launchpad.TokenMetadata("", "", "", "", "", ""), address(0), false);
    }

    function _reserves(address token) internal view returns (uint256 rToken, uint256 rWeth, address pair) {
        pair = factory.getPair(token, address(weth));
        if (pair == address(0)) return (0, 0, pair);
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rToken, rWeth) = MockV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Pool price in wei per token, vs the price the migrator was given.
    function _assertPriceNear(uint256 rToken, uint256 rWeth, uint256 wantWeth, uint256 wantToken, uint256 bps) internal pure {
        uint256 pool = rWeth * 1e18 / rToken;
        uint256 want = wantWeth * 1e18 / wantToken;
        uint256 diff = pool > want ? pool - want : want - pool;
        assertLe(diff * 10_000, want * bps, "pool price off the curve's");
    }

    function test_freshPairSeedsAtTheCurvePrice() public {
        pad.setMigrator(address(migrator));
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0); // crosses graduation, auto-migrates
        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(realEth, 0, "auto-migrated in the same transaction");
        (uint256 rToken, uint256 rWeth, address pair) = _reserves(token);
        assertEq(rToken, pad.DEX_RESERVE(), "the whole reserve is in the pool");
        assertGt(rWeth, 0);
        assertEq(IERC20(token).balanceOf(treasury), 0, "nothing swept aside");
        assertEq(MockV2Pair(pair).balanceOf(address(migrator)), migrator.liquidity(token));
        assertGt(migrator.liquidity(token), 0, "the LP tokens are locked in the adapter");
    }

    /// Anyone can create the pair first and put the quote side in it (the
    /// token cannot move before graduation). The router's addLiquidity would
    /// divide by zero on that; the adapter absorbs it, our deposit sets the price.
    function test_aDonatedQuoteSideIsAbsorbed() public {
        pad.setMigrator(address(migrator));
        address token = _create();
        address pair = factory.createPair(token, address(weth));
        vm.startPrank(griefer);
        weth.deposit{value: 5 ether}();
        weth.transfer(pair, 5 ether);
        MockV2Pair(pair).sync();
        vm.stopPrank();

        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0);
        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertEq(realEth, 0, "the migration went through despite the pre-existing pair");
        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        assertEq(rToken, pad.DEX_RESERVE());
        assertGt(rWeth, 5 ether, "the donation stays in the pool, on top of the raise");
        assertEq(IERC20(token).balanceOf(treasury), 0);
        assertGt(migrator.liquidity(token), 0);
    }

    /// Puts most of the supply in the pair against a little quote: a deep pool
    /// at a fraction of the curve's price, as in the attack this replaces.
    function _attackerPool(address token) internal returns (address pair, uint256 attackerTokens, uint256 attackerWeth) {
        pair = factory.createPair(token, address(weth));
        attackerTokens = IERC20(token).balanceOf(buyer);
        attackerWeth = 10 ether;
        vm.prank(buyer);
        IERC20(token).transfer(pair, attackerTokens);
        vm.startPrank(griefer);
        weth.deposit{value: attackerWeth}();
        weth.transfer(pair, attackerWeth);
        MockV2Pair(pair).mint(griefer);
        vm.stopPrank();
    }

    /// The window after graduation (here: no migrator was set yet; on a live
    /// pad, the automatic migration starved of gas) is open to anyone minting
    /// liquidity at a wild price. Deep and cheap — the attack: trading it to
    /// our price would buy the attacker's tokens with the raise. The adapter
    /// does not: the reserve is parked, still the coin's, nothing of ours
    /// reaches the pool, and the attacker's liquidity is worth what they put in.
    function test_aDeepCheapPoolParksTheReserve() public {
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0); // graduates; nothing migrates yet
        (,, uint256 raised,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated);
        assertGt(raised, 0, "the raise waits in the launchpad");
        (address pair, uint256 attackerTokens, uint256 attackerWeth) = _attackerPool(token);

        pad.setMigrator(address(migrator));
        pad.migrate(token); // anyone may

        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        assertEq(rToken, attackerTokens, "the pool is untouched");
        assertEq(rWeth, attackerWeth, "not a wei of the raise went in");
        assertEq(migrator.liquidity(token), 0, "no position in somebody else's pool");
        (uint256 pT, uint256 pQ) = migrator.parked(token);
        assertEq(pT, pad.DEX_RESERVE(), "the reserve is parked");
        assertEq(pQ, raised, "the raise is parked");
        assertEq(IERC20(token).balanceOf(treasury), 0, "nothing swept to the treasury");
        assertEq(IERC20(token).balanceOf(address(migrator)), pT);
        assertEq(weth.balanceOf(address(migrator)), pQ);
        assertEq(migrator.buybackCap(token), 0, "nothing to buy back from");
        assertFalse(migrator.seed(token), "still at the other price: still parked");
    }

    /// ...and once the attacker leaves, the parked reserve lands at the curve's price.
    function test_aParkedReserveLandsWhenTheAttackerLeaves() public {
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0);
        (,, uint256 raised,,,,) = pad.curves(token);
        (address pair, uint256 attackerTokens, uint256 attackerWeth) = _attackerPool(token);
        pad.setMigrator(address(migrator));
        pad.migrate(token);

        // the attacker withdraws: back out comes what went in, no raise inside
        uint256 lp = MockV2Pair(pair).balanceOf(griefer);
        vm.startPrank(griefer);
        MockV2Pair(pair).transfer(pair, lp);
        (uint256 a0, uint256 a1) = MockV2Pair(pair).burn(griefer);
        vm.stopPrank();
        (uint256 outTokens, uint256 outWeth) = MockV2Pair(pair).token0() == token ? (a0, a1) : (a1, a0);
        assertLe(outWeth, attackerWeth, "no quote of ours in the attacker's liquidity");
        assertLe(outTokens, attackerTokens, "no tokens of ours either");

        // the pool keeps Uniswap's minimum liquidity as dust at the attacker's
        // price: moving that costs nothing, so the parked reserve lands now
        assertTrue(migrator.seed(token));
        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        _assertPriceNear(rToken, rWeth, raised, pad.DEX_RESERVE(), 100);
        assertGt(rToken, pad.DEX_RESERVE() * 99 / 100, "(almost) the whole reserve reached the pool");
        assertGt(migrator.liquidity(token), 0);
        (uint256 pT, uint256 pQ) = migrator.parked(token);
        assertEq(pT + pQ, 0, "nothing parked any more");
        assertLt(IERC20(token).balanceOf(treasury), pad.DEX_RESERVE() / 100, "only the ratio's remainder went to the treasury");
    }

    /// A little liquidity at a price far above ours (dust, or a griefer's
    /// twenty WETH against one token) is sold into, down to our price, which
    /// costs a sliver of tokens and brings their quote back: the manipulator
    /// pays, and the reserve joins the pool at the curve's price.
    function test_aDearDustPoolIsSoldIntoAndJoined() public {
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0);
        (,, uint256 raised,,,,) = pad.curves(token);

        // 1 token : 20 WETH — twenty thousand times the curve's price
        address pair = factory.createPair(token, address(weth));
        vm.prank(buyer);
        IERC20(token).transfer(pair, 1e18);
        vm.startPrank(griefer);
        weth.deposit{value: 20 ether}();
        weth.transfer(pair, 20 ether);
        MockV2Pair(pair).mint(griefer);
        vm.stopPrank();

        pad.setMigrator(address(migrator));
        pad.migrate(token);

        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        _assertPriceNear(rToken, rWeth, raised, pad.DEX_RESERVE(), 100);
        assertGt(rToken, pad.DEX_RESERVE() * 99 / 100, "(almost) the whole reserve reached the pool");
        assertGt(migrator.liquidity(token), 0);
        (uint256 pT, uint256 pQ) = migrator.parked(token);
        assertEq(pT + pQ, 0);
        uint256 share = MockV2Pair(pair).balanceOf(griefer) * 1e18 / MockV2Pair(pair).totalSupply();
        assertLt(rWeth * share / 1e18, 20 ether, "the manipulator paid for the manipulation");
        assertGt(treasury.balance, 0, "what the sale brought in beyond the pool's ratio went to the treasury, unwrapped");
    }

    /// Liquidity already there at our price (within tolerance) is simply
    /// joined at its ratio; the sliver the ratio leaves over goes to the treasury.
    function test_aPoolAtOurPriceIsJoined() public {
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0);
        (,, uint256 raised,,,,) = pad.curves(token);

        address pair = factory.createPair(token, address(weth));
        uint256 someTokens = 1_000_000e18;
        uint256 someWeth = raised * someTokens / pad.DEX_RESERVE(); // exactly our price
        vm.prank(buyer);
        IERC20(token).transfer(pair, someTokens);
        vm.startPrank(griefer);
        weth.deposit{value: someWeth}();
        weth.transfer(pair, someWeth);
        MockV2Pair(pair).mint(griefer);
        vm.stopPrank();

        pad.setMigrator(address(migrator));
        pad.migrate(token);
        (uint256 rToken, uint256 rWeth,) = _reserves(token);
        _assertPriceNear(rToken, rWeth, raised, pad.DEX_RESERVE(), 10);
        assertGe(rToken, pad.DEX_RESERVE(), "the whole reserve joined");
        assertGt(migrator.liquidity(token), 0);
        (uint256 pT, uint256 pQ) = migrator.parked(token);
        assertEq(pT + pQ, 0);
        // the pool's ratio was set from the raise alone; what the launchpad added (the coin's liquidity pot) is the remainder
        assertLt(IERC20(token).balanceOf(treasury), 1e12, "no tokens left over");
        assertLt(treasury.balance, raised / 100, "only the pot's sliver of quote went to the treasury");
    }

    /// A migration to another chain gets the parked reserve back too.
    function test_unlockReturnsWhatIsParked() public {
        address token = _create();
        vm.prank(buyer);
        pad.buy{value: 50 ether}(token, 0);
        (,, uint256 raised,,,,) = pad.curves(token);
        (address pair,,) = _attackerPool(token);
        pad.setMigrator(address(migrator));
        pad.migrate(token);
        (uint256 pT, uint256 pQ) = migrator.parked(token);
        assertEq(pT, pad.DEX_RESERVE(), "parked, as the pool is the attacker's");

        address bridge = makeAddr("bridge");
        vm.prank(address(pad));
        (uint256 quoteOut, uint256 tokenOut, address got) = migrator.unlock(token, bridge);
        assertEq(got, pair);
        assertEq(quoteOut, raised);
        assertEq(tokenOut, pad.DEX_RESERVE());
        assertEq(weth.balanceOf(bridge), raised);
        (pT, pQ) = migrator.parked(token);
        assertEq(pT + pQ, 0);
        vm.prank(address(pad));
        vm.expectRevert(UniV2Migrator.NothingToUnlock.selector);
        migrator.unlock(token, bridge);
    }

    function test_onlyTheLaunchpadMigrates() public {
        vm.expectRevert(UniV2Migrator.OnlyLaunchpad.selector);
        migrator.migrate{value: 1 ether}(address(weth), 1e18, address(0), 0);
    }
}
