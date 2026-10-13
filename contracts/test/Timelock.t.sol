// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "openzeppelin-contracts/contracts/governance/TimelockController.sol";
import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {LaunchpadBase} from "../src/LaunchpadBase.sol";
import {MigrateFromLedger} from "../script/MigrateFromLedger.s.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";

/// The Launchpad owned by a timelock: no owner call runs before its delay
/// has passed in the open, the ledger migration included — the migration
/// functions live in the LaunchpadMigration module, reached through the
/// Launchpad's fallback, and the timelock reaches them the same way. The one
/// shortcut is the migration operator, named through the timelock, who then
/// runs the migration in without a delay.
contract TimelockTest is Test {
    Launchpad pad;
    TimelockController timelock;
    MigrateFromLedger script;
    uint256 constant DELAY = 2 days;
    bytes32 constant ROOT = bytes32(uint256(0x46c19381e8fb095571fe24d39cc68c42759b31f87aacc32c6866c3053061718e));

    function setUp() public {
        pad = new Launchpad(makeAddr("treasury"));
        script = new MigrateFromLedger();
        // the test proposes fee changes, the script proposes the migration; anyone executes
        address[] memory proposers = new address[](2);
        proposers[0] = address(this);
        proposers[1] = address(script);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(DELAY, proposers, executors, address(0));
        pad.transferOwnership(address(timelock));
    }

    function test_ownerCallsWaitForTheDelay() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        pad.setFeeBps(200);

        bytes memory data = abi.encodeCall(pad.setFeeBps, (200));
        bytes32 salt = keccak256("fee to 2%");
        timelock.schedule(address(pad), 0, data, bytes32(0), salt, DELAY);
        bytes32 id = timelock.hashOperation(address(pad), 0, data, bytes32(0), salt);
        assertTrue(timelock.isOperationPending(id));
        assertEq(timelock.getTimestamp(id), block.timestamp + DELAY, "the change is announced two days ahead");

        vm.expectRevert();
        timelock.execute(address(pad), 0, data, bytes32(0), salt);
        assertEq(pad.feeBps(), 50, "nothing changed early");

        vm.warp(block.timestamp + DELAY);
        vm.prank(makeAddr("anyone"));
        timelock.execute(address(pad), 0, data, bytes32(0), salt);
        assertEq(pad.feeBps(), 200);
        assertTrue(timelock.isOperationDone(id));
    }

    /// One call on the pad, scheduled and, a delay later, executed through the timelock.
    function _viaTimelock(bytes memory data, bytes32 salt) internal {
        timelock.schedule(address(pad), 0, data, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(pad), 0, data, bytes32(0), salt);
    }

    /// The operator is the owner's to name, so the name is public a delay ahead;
    /// once named, the operator runs the migration at once against the root the
    /// timelock committed, and the owner's other powers stay behind the delay.
    function test_setMigrationOperatorThroughTheTimelock() public {
        ILaunchpadMigration mig = ILaunchpadMigration(address(pad));
        address op = makeAddr("operator");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        mig.setMigrationOperator(op);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, op));
        mig.setMigrationRoot(ROOT, 100);

        bytes memory data = abi.encodeCall(ILaunchpadMigration.setMigrationOperator, (op));
        bytes32 salt = keccak256("the operator for the move");
        timelock.schedule(address(pad), 0, data, bytes32(0), salt, DELAY);
        vm.expectRevert();
        timelock.execute(address(pad), 0, data, bytes32(0), salt);
        assertEq(pad.migrationOperator(), address(0), "nothing changed early");

        vm.warp(block.timestamp + DELAY);
        vm.expectEmit(address(pad));
        emit LaunchpadBase.MigrationOperatorUpdated(op);
        vm.prank(makeAddr("anyone"));
        timelock.execute(address(pad), 0, data, bytes32(0), salt);
        assertEq(pad.migrationOperator(), op, "the module ran in the pad's storage, as the timelock");

        // the root is the timelock's to commit, a delay ahead like the operator's name
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, op));
        mig.setMigrationRoot(ROOT, 100);
        _viaTimelock(abi.encodeCall(ILaunchpadMigration.setMigrationRoot, (ROOT, 100)), keccak256("the root"));
        assertEq(pad.migrationRoot(), ROOT);
        // but cannot end it, nor freeze the pad, nor pass the role on: those stay the timelock's
        vm.startPrank(op);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, op));
        mig.closeMigration();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, op));
        mig.announceFreeze(block.number + 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, op));
        mig.setMigrationOperator(address(this));
        vm.stopPrank();

        // closing, through the timelock, clears the operator with it
        data = abi.encodeCall(ILaunchpadMigration.closeMigration, ());
        salt = keccak256("close the migration");
        timelock.schedule(address(pad), 0, data, bytes32(0), salt, DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(pad), 0, data, bytes32(0), salt);
        assertTrue(pad.migrationClosed());
        assertEq(pad.migrationOperator(), address(0), "the role ended with the migration");
    }

    /// The live runbook: the timelock names the deployer (here: the script) operator,
    /// and the script then runs the whole demo ledger in directly, no round of
    /// scheduling per batch.
    function test_theOperatorMigratesWithoutTheDelay() public {
        string memory json = vm.readFile("test/fixtures/migration-demo.json");
        MigrateFromLedger.Coin[] memory coins = script.load(json);
        uint256 total;
        for (uint256 i = 0; i < coins.length; i++) {
            total += coins[i].realQuote;
        }
        vm.deal(address(script), total);
        // the root is the timelock's: the script cannot set it, named operator or not
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(script)));
        script.ensureRoot(pad, json);

        bytes memory data = abi.encodeCall(ILaunchpadMigration.setMigrationOperator, (address(script)));
        timelock.schedule(address(pad), 0, data, bytes32(0), bytes32(0), DELAY);
        vm.warp(block.timestamp + DELAY);
        timelock.execute(address(pad), 0, data, bytes32(0), bytes32(0));
        assertEq(pad.migrationOperator(), address(script));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(script)));
        script.ensureRoot(pad, json);

        // the timelock commits the root (timelock.sh safe-calldata set-root FILE); the script finds it and goes on
        (bytes32 root, uint256 freeze) = script.rootOf(json);
        _viaTimelock(abi.encodeCall(ILaunchpadMigration.setMigrationRoot, (root, freeze)), keccak256("the root"));
        script.ensureRoot(pad, json);
        address[] memory tokens = script.migrateAll(pad, coins);
        assertEq(tokens.length, 3);
        assertEq(pad.tokenCount(), 3);
        assertEq(address(pad).balance, total, "every reserve arrived, from the operator");
        assertTrue(script.allMigrated(pad, coins));
        for (uint256 i = 0; i < coins.length; i++) {
            address token = pad.migratedTicker(keccak256(bytes(coins[i].symbol)));
            assertEq(pad.migrationPending(token), 0);
            for (uint256 j = 0; j < coins[i].holders.length; j++) {
                assertEq(IERC20(token).balanceOf(coins[i].holders[j]), coins[i].balances[j]);
            }
        }
        // and the timelock's plan finds nothing left to do
        (uint256 opCount,,) = script.planSummary(pad, json, coins);
        assertEq(opCount, 0);
    }

    function test_tooShortADelayIsRefused() public {
        bytes memory data = abi.encodeCall(pad.setTreasury, (makeAddr("other")));
        vm.expectRevert();
        timelock.schedule(address(pad), 0, data, bytes32(0), bytes32(0), 1 hours);
    }

    function test_demoLedgerMigratesThroughTheTimelock() public {
        string memory json = vm.readFile("test/fixtures/migration-demo.json");
        MigrateFromLedger.Coin[] memory coins = script.load(json);
        uint256 total;
        for (uint256 i = 0; i < coins.length; i++) {
            total += coins[i].realQuote;
        }
        vm.deal(address(script), total);

        // the plan: the root, then every coin, in one operation of a few calls
        (uint256 opCount, uint256[] memory callsPerOp, bytes4[] memory selectors) = script.planSummary(pad, json, coins);
        assertEq(opCount, 1, "three coins and the root fit one operation");
        assertEq(callsPerOp[0], 4);
        assertEq(selectors[0], ILaunchpadMigration.setMigrationRoot.selector, "the root comes first");
        assertEq(selectors[1], ILaunchpadMigration.migrateToken.selector);
        assertEq(selectors[3], ILaunchpadMigration.migrateToken.selector);

        assertEq(script.scheduleFromFile(timelock, pad, json, coins), 1);
        assertEq(script.scheduleFromFile(timelock, pad, json, coins), 0, "scheduling again changes nothing");
        assertFalse(script.allMigrated(pad, coins));

        // not before the delay: the execute round finds nothing ready and does nothing
        assertEq(script.executeFromFile(timelock, pad, json, coins), 0);
        assertEq(pad.tokenCount(), 0);
        assertEq(pad.migrationRoot(), bytes32(0));

        vm.warp(block.timestamp + DELAY);
        assertEq(script.executeFromFile(timelock, pad, json, coins), 1, "the same plan, now ready, runs");
        assertEq(pad.tokenCount(), 3);
        assertEq(
            pad.migrationRoot(), bytes32(uint256(0x46c19381e8fb095571fe24d39cc68c42759b31f87aacc32c6866c3053061718e))
        );
        assertEq(address(pad).balance, total, "every reserve arrived through the timelock");
        assertTrue(script.allMigrated(pad, coins));
        for (uint256 i = 0; i < coins.length; i++) {
            address token = pad.migratedTicker(keccak256(bytes(coins[i].symbol)));
            assertEq(pad.migrationPending(token), 0);
            for (uint256 j = 0; j < coins[i].holders.length; j++) {
                assertEq(IERC20(token).balanceOf(coins[i].holders[j]), coins[i].balances[j]);
            }
        }
        // nothing left to plan, schedule or execute
        (opCount,,) = script.planSummary(pad, json, coins);
        assertEq(opCount, 0);
        assertEq(script.scheduleFromFile(timelock, pad, json, coins), 0);
    }

    /// A coin with more holders than one batch carries.
    function _crowd(uint256 n) internal returns (MigrateFromLedger.Coin[] memory coins) {
        address[] memory holders = new address[](n);
        uint256[] memory balances = new uint256[](n);
        uint256 sold;
        for (uint256 i = 0; i < n; i++) {
            holders[i] = address(uint160(0x1000 + i));
            balances[i] = 1_000_000e18;
            sold += balances[i];
        }
        coins = new MigrateFromLedger.Coin[](1);
        coins[0].balances = balances;
        coins[0].creator = makeAddr("creator");
        coins[0].creatorBps = 10_000; // its pot to the creator, no tax of its own
        coins[0].holders = holders;
        coins[0].name = "Crowd";
        coins[0].sold = sold;
        coins[0].symbol = "CROWD";
        coins[0].virtualQuote = 0.2 ether;
        // the reserve a constant-product curve holds for what was sold
        coins[0].realQuote = (coins[0].virtualQuote * sold) / (pad.VIRTUAL_TOKEN() - sold);
        vm.deal(address(script), coins[0].realQuote);
    }

    /// The crowd's file, as far as the plan reads it: the root of its tree (the script
    /// refuses a file whose root is not its coins'), the freeze height, the network.
    function _crowdJson(MigrateFromLedger.Coin[] memory coins) internal view returns (string memory) {
        bytes32 root = script.treeRoot(coins, address(0));
        string memory hex_ = vm.toString(root);
        bytes memory b = bytes(hex_);
        bytes memory noPrefix = new bytes(b.length - 2);
        for (uint256 i = 2; i < b.length; i++) {
            noPrefix[i - 2] = b[i];
        }
        return string.concat('{"stateRoot":"', string(noPrefix), '","freezeHeight":100,"network":"test","coins":[]}');
    }

    /// Schedule, wait out the delay, execute; the plan's shape before it ran.
    function _round(MigrateFromLedger.Coin[] memory coins) internal returns (uint256 calls, bytes4 firstSelector) {
        string memory json = _crowdJson(coins);
        (uint256 opCount, uint256[] memory callsPerOp, bytes4[] memory selectors) = script.planSummary(pad, json, coins);
        assertEq(opCount, 1);
        calls = callsPerOp[0];
        firstSelector = selectors[0];
        assertEq(script.scheduleFromFile(timelock, pad, json, coins), 1);
        vm.warp(block.timestamp + DELAY);
        assertEq(script.executeFromFile(timelock, pad, json, coins), 1);
    }

    function test_manyHoldersTakeASecondRound() public {
        uint256 n = script.BATCH() + 20;
        MigrateFromLedger.Coin[] memory coins = _crowd(n);

        // creation delivers BATCH holders; the rest waits for the token address
        (uint256 calls, bytes4 first) = _round(coins);
        assertEq(calls, 2, "root and the creation with the first batch");
        assertEq(first, ILaunchpadMigration.setMigrationRoot.selector);
        address token = pad.migratedTicker(keccak256(bytes("CROWD")));
        assertTrue(token != address(0));
        assertEq(pad.migrationPending(token), 20 * 1_000_000e18, "twenty holders still to deliver");
        assertFalse(script.allMigrated(pad, coins));

        // the second round: only the twenty, to the token that now exists
        (calls, first) = _round(coins);
        assertEq(calls, 1);
        assertEq(first, ILaunchpadMigration.migrateBalances.selector);
        assertEq(pad.migrationPending(token), 0);
        assertTrue(script.allMigrated(pad, coins));
        assertEq(IERC20(token).balanceOf(address(uint160(0x1000 + n - 1))), 1_000_000e18);
    }
}
