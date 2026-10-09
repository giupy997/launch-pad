// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair} from "./mocks/UniV2Mock.sol";

/// Holder cashback must stay solvent and exact through any mix of activity on
/// a taxed coin: on its curve, and — once it graduated and its pool is
/// registered — on the pool: wallet transfers, self-transfers, pool buys and
/// sells (both legs taxed in coins), harvests that turn the buckets into
/// quote, buybacks, claims. The accumulator moves on curve fees and on
/// poolFee and on nothing else; every claim is backed by what the pad holds;
/// the pool and the migrator never earn; nothing of the coin stays with the
/// pad but the share graduation locks and the two tax buckets.
contract CashbackSolvencyTest is Test {
    Launchpad pad;
    UniV2Migrator migrator;
    MockWETH9 weth;
    MockV2Factory factory;
    address token;
    address pair;
    address treasury = makeAddr("treasury");
    address alice = makeAddr("alice"); // creates the coin
    address whale = makeAddr("whale"); // buys the curve out
    address keeper = makeAddr("keeper"); // harvests and buys back: any EOA
    address[4] holders;
    /// The actors of the fuzz: the four holders and the whale.
    address[] actors;
    /// Everyone who can end up holding the coin or a claim on the pad: the
    /// sums below run over all of them, and the supply check proves the list
    /// is complete.
    address[] everyone;
    LaunchpadBase.TokenMetadata meta = LaunchpadBase.TokenMetadata("", "", "", "", "", "");
    /// 1% a side, the whole tax to holders as cashback.
    LaunchpadBase.FeeConfig holdersOnly = LaunchpadBase.FeeConfig(100, 100, 0, 10_000, 0, 0, 0);
    /// 1% a side with every share live — a quarter to the creator, half to
    /// holders, 15% burned, a tenth to liquidity — so the burn pot, the
    /// buyback and the harvest's liquidity leg take part too.
    LaunchpadBase.FeeConfig everyShare = LaunchpadBase.FeeConfig(100, 100, 2500, 5000, 1500, 1000, 0);
    /// The launchpad's fee as deployed, stamped on every coin: 0.5%.
    uint256 constant PLATFORM = 50;
    /// The pad's accumulator precision (LaunchpadBase.ACC_PRECISION).
    uint256 constant ACC = 1e30;
    uint256 constant STEPS = 48;
    /// What the pad may hold beyond every claim: rounding dust alone. A
    /// settle loses the holder under two wei (the entitlement floors, the
    /// debt ceils) and a step settles two wallets at most, so a run leaves a
    /// few hundred wei behind; anything real stuck in the pad is a leak and
    /// orders of magnitude more.
    uint256 constant DUST = 1000;

    /// What one poolFee booked, read off the event.
    struct Fee {
        uint256 toTreasury;
        uint256 toCreator;
        uint256 toHolders;
        uint256 toBurnPot;
    }

    function setUp() public {
        pad = new Launchpad(treasury);
        weth = new MockWETH9();
        factory = new MockV2Factory();
        migrator = new UniV2Migrator(address(pad), address(new MockV2Router(address(factory), address(weth))));
        pad.setMigrator(address(migrator));
        for (uint256 i = 0; i < 4; i++) {
            holders[i] = makeAddr(string.concat("holder", vm.toString(i)));
            vm.deal(holders[i], 100 ether);
            actors.push(holders[i]);
            everyone.push(holders[i]);
        }
        vm.deal(whale, 100 ether);
        actors.push(whale);
        everyone.push(whale);
        everyone.push(alice);
        everyone.push(treasury);
        everyone.push(keeper);
    }

    // ---------------------------------------------------------------- helpers

    /// A coin of alice's with the four holders on its curve, 0.5 ETH each:
    /// the one coin of the test, so the pad holds nothing but its quote.
    function _launch(LaunchpadBase.FeeConfig memory fees) internal {
        vm.prank(alice);
        token = pad.createTokenWithFees("Solvent", "SOLV", 0, meta, address(0), fees);
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(holders[i]);
            pad.buy{value: 0.5 ether}(token, 0);
        }
    }

    /// The whale buys the curve out: the coin graduates, its pool is seeded at
    /// the closing price, locked and registered. The curve's virtual share of
    /// the DEX reserve stays with the pad for good (lockedAtGraduation): that,
    /// and later the tax buckets, is all of the coin the pad keeps.
    function _graduate() internal {
        vm.prank(whale);
        pad.buy{value: 10 ether}(token, 0); // the curve raises 4 ETH: this crosses the line and refunds the rest
        (,, uint256 realEth,, bool graduated,,) = pad.curves(token);
        assertTrue(graduated, "graduated");
        assertEq(realEth, 0, "the raise left for the pool");
        pair = migrator.pairOf(token);
        assertTrue(pad.taxedPool(token, pair), "the pool is registered: taxed, no cashback");
        assertGt(migrator.liquidity(token), 0, "seeded and locked");
        assertGt(pad.lockedAtGraduation(token), 0, "the virtual share of the reserve stays");
        assertEq(
            IERC20(token).balanceOf(address(pad)),
            pad.lockedAtGraduation(token),
            "graduation leaves the pad the locked share and nothing else of the coin"
        );
        _checkInvariants();
    }

    function _reserves() internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (rToken, rQuote) = MockV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
    }

    /// Uniswap v2's getAmountOut: the pool's own 0.3% on the way in.
    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal pure returns (uint256) {
        return (amountIn * 997 * rOut) / (rIn * 1000 + amountIn * 997);
    }

    /// Take `out` of one side from the pair for `to`: the coin when `wantToken`, the quote otherwise.
    function _swapOut(uint256 out, bool wantToken, address to) internal {
        bool tokenIsZero = MockV2Pair(pair).token0() == token;
        (uint256 out0, uint256 out1) = wantToken == tokenIsZero ? (out, uint256(0)) : (uint256(0), out);
        MockV2Pair(pair).swap(out0, out1, to, "");
    }

    /// A buy on the pool as a router does it: the chain's coin wrapped and sent
    /// to the pair, the coins swapped out to `who` — taxed on the way out by
    /// the coin itself. Returns what the pair paid, before the tax.
    function _poolBuy(address who, uint256 ethIn) internal returns (uint256 out) {
        (uint256 rToken, uint256 rQuote) = _reserves();
        out = _amountOut(ethIn, rQuote, rToken);
        vm.startPrank(who);
        weth.deposit{value: ethIn}();
        weth.transfer(pair, ethIn);
        _swapOut(out, true, who);
        vm.stopPrank();
    }

    /// The quote a sell of `tokensIn` by `who` would bring: the pair is paid the net of the tax.
    function _sellQuote(address who, uint256 tokensIn) internal view returns (uint256) {
        uint256 net = tokensIn - (tokensIn * pad.transferRate(token, who, pair)) / 10_000;
        (uint256 rToken, uint256 rQuote) = _reserves();
        return _amountOut(net, rToken, rQuote);
    }

    /// A sell on the pool: the coins to the pair — taxed on the way, so the
    /// pair gets the net — and the quote the net buys swapped out to `who`
    /// and unwrapped, so the seller can buy again with it.
    function _poolSell(address who, uint256 tokensIn) internal returns (uint256 quoteOut) {
        quoteOut = _sellQuote(who, tokensIn);
        vm.startPrank(who);
        IERC20(token).transfer(pair, tokensIn);
        _swapOut(quoteOut, false, who);
        weth.withdraw(quoteOut);
        vm.stopPrank();
    }

    /// A harvest by the keeper in a fresh block. One with nothing to sell is
    /// skipped (the buckets empty, or a slice too small to buy any quote);
    /// any other revert fails the test. Returns what poolFee booked, read
    /// off its event.
    function _harvest() internal returns (bool done, Fee memory fee) {
        vm.roll(block.number + 1);
        vm.recordLogs();
        vm.prank(keeper);
        try migrator.harvest(token) {
            done = true;
        } catch (bytes memory err) {
            assertEq(
                bytes32(bytes4(err)),
                bytes32(UniV2Migrator.NothingToSell.selector),
                "a harvest failed for a reason other than an empty slice"
            );
            return (false, fee);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PoolFee(address,uint256,uint256,uint256,uint256)");
        bool seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(pad) && logs[i].topics[0] == sig) {
                assertFalse(seen, "one poolFee per harvest");
                assertEq(address(uint160(uint256(logs[i].topics[1]))), token);
                (fee.toTreasury, fee.toCreator, fee.toHolders, fee.toBurnPot) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                seen = true;
            }
        }
        assertTrue(seen, "a harvest books its quote through poolFee");
    }

    /// A buyback by the keeper in a fresh block, when the burn pot holds
    /// anything; one whose slice would buy nothing is skipped.
    function _buyback() internal returns (bool done) {
        if (pad.burnPot(token) == 0) return false;
        vm.roll(block.number + 1);
        vm.prank(keeper);
        try pad.buybackAndBurn(token) {
            done = true;
        } catch (bytes memory err) {
            assertEq(
                bytes32(bytes4(err)),
                bytes32(LaunchpadBase.ZeroAmount.selector),
                "a buyback failed for a reason other than an empty slice"
            );
        }
    }

    function _cashbacks() internal view returns (uint256[] memory out) {
        out = new uint256[](everyone.length);
        for (uint256 i = 0; i < everyone.length; i++) {
            out[i] = pad.cashbackOf(token, everyone[i]);
        }
    }

    function _assertCashbackUnchanged(uint256[] memory before, string memory why) internal view {
        for (uint256 i = 0; i < everyone.length; i++) {
            assertEq(pad.cashbackOf(token, everyone[i]), before[i], why);
        }
        assertEq(pad.cashbackOf(token, pair), 0, why);
        assertEq(pad.cashbackOf(token, address(migrator)), 0, why);
    }

    /// Wallets with coins right now: what the accumulator's rounding is counted per.
    function _holdersWithCoins() internal view returns (uint256 n) {
        for (uint256 i = 0; i < everyone.length; i++) {
            if (IERC20(token).balanceOf(everyone[i]) != 0) n++;
        }
    }

    /// What must hold after graduation, after every step.
    function _checkInvariants() internal view {
        uint256 supply = IERC20(token).totalSupply();
        uint256 padT = IERC20(token).balanceOf(address(pad));
        uint256 pairT = IERC20(token).balanceOf(pair);
        uint256 migT = IERC20(token).balanceOf(address(migrator));
        assertEq(pad.eligibleSupply(token), supply - padT - pairT - migT, "eligible supply in sync");

        // the coin is nowhere this test does not look: the sums over `everyone` run over every holder
        uint256 held;
        for (uint256 i = 0; i < everyone.length; i++) {
            held += IERC20(token).balanceOf(everyone[i]);
        }
        assertEq(held + padT + pairT + migT, supply, "every coin is accounted for");

        // the pad keeps of the coin exactly what graduation locked and the two unsold tax buckets
        assertEq(
            padT,
            pad.lockedAtGraduation(token) + pad.taxTreasury(token) + pad.taxPot(token),
            "the pad holds the locked share and the tax buckets, nothing else of the coin"
        );

        // every claim is backed: the curve's reserve (0 once graduated), the creator's fees, everyone's
        // cashback, the two pots
        (,, uint256 realEth,,,,) = pad.curves(token);
        uint256 owed = realEth + pad.creatorFees(alice, address(0)) + pad.creatorFees(treasury, address(0))
            + pad.burnPot(token) + pad.liquidityPot(token);
        for (uint256 i = 0; i < everyone.length; i++) {
            owed += pad.cashbackOf(token, everyone[i]);
        }
        assertLe(owed, address(pad).balance, "every claim, and every pot, is backed");
        assertLe(address(pad).balance - owed, DUST, "the pad keeps rounding dust alone beyond the claims");

        // the pool, the migrator and the pad earn nothing
        assertEq(pad.cashbackOf(token, pair), 0, "the pool earns no cashback");
        assertEq(pad.cashbackOf(token, address(migrator)), 0, "nor the migrator");
        assertEq(pad.cashbackOf(token, address(pad)), 0, "nor the pad");

        // the migrator keeps no quote: a harvest hands all of it on, a buyback spends all of it
        assertEq(weth.balanceOf(address(migrator)), 0, "the migrator holds no wrapped quote");
        assertEq(address(migrator).balance, 0, "nor any native quote");
    }

    // ---------------------------------------------------------------- the fuzz

    /// Forty-eight random steps on the pool coin whose whole tax is the holders'.
    function testFuzz_solventAndInSync(uint256 seed) public {
        _launch(holdersOnly);
        _graduate();
        _run(seed);
    }

    /// The same, on a coin with every share live: the creator's fees, the
    /// burn pot and its buybacks, the liquidity pot joining the pool at
    /// graduation and the harvest deepening (or folding) the liquidity share.
    function testFuzz_solventAndInSyncWithEveryShare(uint256 seed) public {
        _launch(everyShare);
        _graduate();
        _run(seed);
    }

    function _run(uint256 seed) internal {
        for (uint256 step = 0; step < STEPS; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            address a = actors[seed % actors.length];
            address b = actors[(seed >> 8) % actors.length];
            uint256 op = (seed >> 16) % 8;
            uint256 bal = IERC20(token).balanceOf(a);
            uint256 amount = bal == 0 ? 0 : (seed >> 24) % (bal + 1);
            emit log_named_uint("step", step);
            emit log_named_uint("op", op);

            if (op == 0) {
                vm.prank(a);
                IERC20(token).transfer(b, amount); // wallet to wallet, untaxed; a self-transfer when a == b
            } else if (op == 1) {
                vm.prank(a);
                IERC20(token).transfer(a, bal); // an explicit self-transfer of everything
            } else if (op == 2) {
                _poolBuy(a, ((seed >> 24) % 0.2 ether) + 1e15); // a buy: the pool pays out, the buy rate off it
            } else if (op == 3) {
                // a sell: the pool is paid, the sell rate off it (skipped when the net would buy no quote)
                if (amount != 0 && _sellQuote(a, amount) != 0) _poolSell(a, amount);
            } else if (op == 4) {
                _harvestAndCheck();
            } else if (op == 5) {
                _buyback();
            } else if (op == 6) {
                if (pad.cashbackOf(token, a) != 0) {
                    vm.prank(a);
                    pad.claimCashback(token);
                }
            } else {
                if (pad.creatorFees(alice, address(0)) != 0) {
                    vm.prank(alice);
                    pad.claimCreatorFees(address(0));
                } else if (pad.cashbackOf(token, b) != 0) {
                    vm.prank(b);
                    pad.claimCashback(token);
                }
            }

            _checkInvariants();
        }
    }

    /// A harvest, and the exact booking of what it realised: the holders'
    /// share moves the accumulator by its spread over the eligible supply,
    /// the creator's share is theirs to claim, the burn-pot share waits for a
    /// buyback, the treasury is paid at once.
    function _harvestAndCheck() internal {
        uint256 accBefore = pad.accCashbackPerShare(token);
        uint256 eligible = pad.eligibleSupply(token);
        uint256 creatorBefore = pad.creatorFees(alice, address(0));
        uint256 burnBefore = pad.burnPot(token);
        uint256 treasuryBefore = treasury.balance;
        uint256 bucketsBefore = pad.taxTreasury(token) + pad.taxPot(token);
        (bool done, Fee memory fee) = _harvest();
        if (!done) {
            assertEq(pad.taxTreasury(token) + pad.taxPot(token), bucketsBefore, "a skipped harvest takes nothing");
            return;
        }
        assertGe(eligible, 1e18, "the holders are there to be paid");
        assertEq(
            pad.accCashbackPerShare(token) - accBefore,
            (fee.toHolders * ACC) / eligible,
            "the holders' share of a harvest, spread over the eligible supply and nothing else"
        );
        assertEq(pad.creatorFees(alice, address(0)) - creatorBefore, fee.toCreator, "the creator's share, to claim");
        assertEq(pad.burnPot(token) - burnBefore, fee.toBurnPot, "the burn-pot share waits for a buyback");
        assertEq(treasury.balance - treasuryBefore, fee.toTreasury, "the treasury's part, paid at once");
        assertLt(pad.taxTreasury(token) + pad.taxPot(token), bucketsBefore, "a slice left the buckets");
    }

    // ---------------------------------------------------------------- the regression

    /// The SelfTransferExploit class of bug, on the pool: a holder who sells
    /// into the pair and buys straight back, round after round with no
    /// harvest between, must not move anyone's cashback by a wei — the pool
    /// tax is booked in coins and becomes cashback at the harvest alone, and a
    /// trade re-anchors the trader's debt at the new balance exactly. One
    /// harvest then credits the holders exactly the holders' share poolFee
    /// delivered, to the accumulator's rounding.
    function test_sellAndBuyBackLoopNeverMintsCashback() public {
        _launch(holdersOnly);
        _graduate();
        address a = holders[0];
        uint256[] memory before = _cashbacks();
        uint256 acc = pad.accCashbackPerShare(token);
        uint256 bucketsBefore = pad.taxTreasury(token) + pad.taxPot(token);
        for (uint256 round = 0; round < 20; round++) {
            uint256 got = _poolSell(a, IERC20(token).balanceOf(a) / 5);
            assertGt(got, 0);
            _assertCashbackUnchanged(before, "a sell moves nobody's cashback");
            _poolBuy(a, got);
            _assertCashbackUnchanged(before, "a buy moves nobody's cashback");
            _checkInvariants();
        }
        assertEq(pad.accCashbackPerShare(token), acc, "the accumulator moved on none of the forty legs");
        assertGt(pad.taxPot(token), bucketsBefore, "the tax is in coins, waiting for the harvest");

        // the one harvest: the holders get exactly the holders' share it delivered
        uint256 eligible = pad.eligibleSupply(token);
        (bool done, Fee memory fee) = _harvest();
        assertTrue(done, "the buckets had coins to sell");
        assertGt(fee.toHolders, 0, "the holders' share is the whole of the coin's tax");
        assertEq(fee.toCreator + fee.toBurnPot, 0, "no other share on this coin");
        assertEq(pad.accCashbackPerShare(token) - acc, (fee.toHolders * ACC) / eligible, "spread over the holders alone");
        uint256[] memory after_ = _cashbacks();
        uint256 credited;
        for (uint256 i = 0; i < everyone.length; i++) {
            assertGe(after_[i], before[i], "a harvest takes nothing from anyone");
            credited += after_[i] - before[i];
        }
        // the entitlement rounds down and a debt re-anchored by a trade rounded up: two wei per holder at most
        assertApproxEqAbs(credited, fee.toHolders, 2 * _holdersWithCoins(), "the holders' share, whole, to the holders");
        assertEq(pad.cashbackOf(token, pair), 0, "the pool earned none of it");
        assertEq(pad.cashbackOf(token, address(migrator)), 0, "nor the migrator");
        _checkInvariants();
    }

    // ---------------------------------------------------------------- the curve

    /// A curve buy on the holders' coin: the launchpad's 0.5% goes to the
    /// treasury straight out, the coin's 1% is the holders' whole, spread
    /// over the eligible supply with the buyer's own coins in it (they are
    /// his before the fee is split).
    function test_curveFeesReachTheHoldersWhole() public {
        _launch(holdersOnly);
        uint256 held;
        for (uint256 i = 0; i < 4; i++) {
            held += IERC20(token).balanceOf(holders[i]);
        }
        assertEq(pad.eligibleSupply(token), held, "only wallets count: the pad's inventory does not");

        uint256 before = _claimable();
        uint256 treasuryBefore = treasury.balance;
        uint256 accBefore = pad.accCashbackPerShare(token);
        address dave = makeAddr("dave");
        vm.deal(dave, 1 ether);
        vm.prank(dave);
        pad.buy{value: 1 ether}(token, 0);

        // 1 ETH at 0.5% + 1%: a 0.015 ETH fee, of which the platform's 0.005 ETH leaves at once
        uint256 toHolders = 0.01 ether;
        assertEq(treasury.balance - treasuryBefore, 0.005 ether, "the platform part, straight to the treasury");
        uint256 eligible = pad.eligibleSupply(token);
        assertEq(eligible, held + IERC20(token).balanceOf(dave), "dave's coins count: his before the split");
        assertEq(
            pad.accCashbackPerShare(token) - accBefore,
            (toHolders * ACC) / eligible,
            "the coin's whole tax to the accumulator, spread over the eligible supply"
        );
        uint256 credited = _claimable() + pad.cashbackOf(token, dave) - before;
        // five holders: the accumulator's rounding costs each a wei at most
        assertApproxEqAbs(credited, toHolders, 5, "the holders' cashback grew by the coin's tax, to rounding");
        assertLe(credited, toHolders, "never more than what came in");
        assertEq(pad.creatorFees(alice, address(0)), 0, "no creator share on this coin");
        assertEq(pad.burnPot(token) + pad.liquidityPot(token), 0, "no burn or liquidity share either");

        // and every claim is backed, the curve's reserve beside them
        (,, uint256 realEth,,,,) = pad.curves(token);
        assertLe(realEth + credited + before, address(pad).balance, "the reserve and every claim are backed");
        assertLe(address(pad).balance - realEth - credited - before, DUST, "and the pad keeps rounding dust beyond them");
    }

    function _claimable() internal view returns (uint256 total) {
        for (uint256 i = 0; i < 4; i++) {
            total += pad.cashbackOf(token, holders[i]);
        }
    }
}
