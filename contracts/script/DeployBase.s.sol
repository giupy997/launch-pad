// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "openzeppelin-contracts/contracts/governance/TimelockController.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {SlipstreamZapRouter} from "../src/SlipstreamZapRouter.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";

/// Base (chain 8453), the whole stack in one run — v12: the launchpad's fee
/// (0.5% a side, the constructor's default, whole to the treasury) and the
/// coin's own tax on every pool trade after graduation too, sold by the
/// migrator's `harvest`; the migration module (`pad.MIGRATION_MODULE()`,
/// deployed by the pad's constructor like its factory) behind the pad's
/// fallback; and, when MIGRATION_OPERATOR is set, the account that may run a
/// migration into this pad without the timelock's delay (a move of coins
/// from another pad or chain: MIGRATION.md), named in the deploy
/// transaction itself, before the timelock takes the pad. Replaces v11
/// (block 52,180,589), which took fees on the curve alone and keeps running
/// with its coins (LAUNCH-BASE-V12.md); v11 had replaced the v9 stack whose pools were taken at block 52,105,142 and the
/// v10 stack deployed the same day before the opening-price change, never
/// used (README, Deployments): the graduation migrates in one piece, the
/// migrator never trades against a pool somebody pre-seeded, and the pool
/// opens at the price the curve closed at. The Launchpad quoted in
/// cbLTC — Coinbase Wrapped LTC, LTC 1:1 in Coinbase custody with a public
/// proof of reserves, 8 decimals — graduating into a locked Uniswap v2 pool
/// (token/cbLTC); the ETH zap through Aerodrome Slipstream, where cbLTC's
/// liquidity is; and the TimelockController that owns the pad from the first
/// block, so that every owner call — fees, treasury, migrator, quote assets,
/// and above all the freeze and migrateOut that take the coins to LitVM
/// mainnet — is public for TIMELOCK_DELAY before it lands.
///
///   cd contracts && source .env && \
///   [TREASURY=0x...] [TIMELOCK_DELAY=86400] [CBLTC_VIRTUAL=5000000000] [MIGRATION_OPERATOR=0x...] forge script script/DeployBase.s.sol \
///     --rpc-url base --account notus --broadcast
///
/// TREASURY defaults to the Notus treasury below.
///
/// CBLTC_VIRTUAL is the virtual reserve a cbLTC curve opens with, in cbLTC
/// units (8 decimals): 50 cbLTC by default (v12; v11 opened with 60) —
/// about 47.6 cbLTC of opening market cap, 160 cbLTC raised to graduate
/// (3.2 times the reserve), ~840 cbLTC of market cap at graduation; a
/// coin migrated here keeps the reserve its own curve was born with. cbLTC
/// is the pad's only
/// quote: the native one is switched off, so no coin can be created that
/// the migration would leave behind. TIMELOCK_DELAY defaults to 24 hours;
/// PROPOSER (default the deployer) may schedule and cancel, anyone may
/// execute what is ready.
///
/// Verify on Blockscout (base.blockscout.com) from this very checkout, each
/// with its constructor arguments (`cast abi-encode`): Launchpad
/// (address treasury), LaunchTokenFactory and LaunchpadMigration (none; the
/// pad deployed both — `pad.tokenFactory()`, `pad.MIGRATION_MODULE()`),
/// UniV2Migrator (pad, router),
/// SlipstreamZapRouter (pad, router, weth), TimelockController
/// (uint256 delay, address[] proposers, address[] executors, address 0).
/// Or by hand with `node script/standard-input.mjs …`.
contract DeployBase is Script {
    /// Coinbase Wrapped LTC on Base (8 decimals).
    address constant CBLTC = 0xcb17C9Db87B595717C857a08468793f5bAb6445F;
    /// Uniswap v2 Router02 on Base: the graduation pools.
    address constant UNIV2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    /// Aerodrome Slipstream SwapRouter (initial deployment, CL factory 0x5e7BB104…): the ETH → cbLTC leg of a zap.
    address constant SLIPSTREAM_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    /// The Notus treasury: the platform fee's share of every trade goes here (TREASURY overrides it).
    address constant TREASURY_DEFAULT = 0x24622320D93Da2d9c626EE469ad0C2c48a1ED7F7;
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    function run() external {
        address treasury = vm.envOr("TREASURY", TREASURY_DEFAULT);
        uint256 virtualReserve = vm.envOr("CBLTC_VIRTUAL", uint256(50 * 1e8));
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(24 hours));
        address proposer = vm.envOr("PROPOSER", msg.sender);
        address operator = vm.envOr("MIGRATION_OPERATOR", address(0));
        require(CBLTC.code.length > 0, "no cbLTC at its address: is this Base?");
        require(SLIPSTREAM_ROUTER.code.length > 0, "no Slipstream router at its address: is this Base?");

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](2);
        executors[0] = proposer;
        executors[1] = address(0); // the open role: anyone may execute what is ready

        vm.startBroadcast();
        Launchpad pad = new Launchpad(treasury);
        UniV2Migrator migrator = new UniV2Migrator(address(pad), UNIV2_ROUTER);
        pad.setMigrator(address(migrator));
        pad.setQuoteAsset(CBLTC, virtualReserve);
        pad.setQuoteAsset(address(0), 0); // cbLTC alone: every coin here must be able to move to LitVM
        if (operator != address(0)) ILaunchpadMigration(address(pad)).setMigrationOperator(operator);
        SlipstreamZapRouter zap = new SlipstreamZapRouter(address(pad), SLIPSTREAM_ROUTER, WETH);
        TimelockController timelock = new TimelockController(delay, proposers, executors, address(0));
        pad.transferOwnership(address(timelock));
        vm.stopBroadcast();

        console.log("Launchpad:          ", address(pad));
        console.log("LaunchTokenFactory: ", address(pad.tokenFactory()));
        console.log("LaunchpadMigration: ", pad.MIGRATION_MODULE());
        console.log("Fee (bps):          ", pad.feeBps());
        console.log("Migration operator: ", operator);
        console.log("UniV2Migrator:      ", address(migrator));
        console.log("SlipstreamZapRouter:", address(zap));
        console.log("Timelock (owner):   ", address(timelock));
        console.log("Delay (s):          ", delay);
        console.log("Proposer:           ", proposer);
        console.log("Treasury:           ", treasury);
        console.log("cbLTC virtual:      ", virtualReserve, "(8 decimals)");
        console.log("Native quote:        off");
        console.log("Deploy block:       ", block.number);
        if (MULTICALL3.code.length == 0) console.log("No Multicall3 on this chain: the web app falls back to single reads");
    }
}
