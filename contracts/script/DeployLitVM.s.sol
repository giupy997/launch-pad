// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "openzeppelin-contracts/contracts/governance/TimelockController.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";

/// LitVM (Litecoin's EVM layer 2, Arbitrum Orbit): the Launchpad quoted in
/// native zkLTC, plus — when UNIV2_ROUTER is set — a Uniswap v2 graduation
/// adapter (LitVM's DEXes are v2 forks; there is no v4 PoolManager, so
/// holder rewards stop at graduation there, like on GIWA).
///
///   cd contracts && source .env && \
///   UNIV2_ROUTER=0x... [TREASURY=0x...] [NATIVE_VIRTUAL=<wei>] [PROPOSER=0x...] [TIMELOCK_DELAY=172800] \
///   [MIGRATION_OPERATOR=0x...] [DEPLOYER_OWNED=true] forge script script/DeployLitVM.s.sol \
///     --rpc-url litvm_testnet --account notus --broadcast
///
/// TREASURY defaults to the deployer. NATIVE_VIRTUAL is the virtual reserve
/// a native-quoted curve opens with, in wei of zkLTC (default the contract's
/// 1.25): a testnet short of zkLTC wants a small one, so that a curve can be
/// bought through graduation with faucet coins — 0.05 zkLTC raises 0.16 to
/// graduate. Mainnet opens with 50 zkLTC (50e18), Base v12's figure: 160
/// zkLTC to graduate, ~840 of market cap there.
///
/// The pad is owned by a TimelockController from its first block, as Base's
/// is (DeployBase.s.sol): deployed in the same broadcast, TIMELOCK_DELAY
/// (48 hours by default) before any owner call lands, PROPOSER (the deployer
/// by default; a Safe for a mainnet pad) the one to schedule and cancel,
/// anyone to execute; no block passes with the pad under a key alone. The
/// migration into it needs no owner call once MIGRATION_OPERATOR is set here
/// (the operator delivers only what the committed snapshot proves). A
/// rehearsal pad on the testnet, redeployed often and driven by hand, takes
/// DEPLOYER_OWNED=true and stays the deployer's, said in so many words.
///
/// Verify both on Blockscout from the same checkout that deployed (same
/// foundry.toml, same solc), passing each constructor's ABI-encoded args
/// (<treasury>, <launchpad>, <migrator> as the deploy printed them):
///
///   forge verify-contract --chain 4441 --verifier blockscout \
///     --verifier-url https://liteforge.explorer.caldera.xyz/api/ --watch \
///     --constructor-args "$(cast abi-encode 'constructor(address)' <treasury>)" \
///     <launchpad> src/Launchpad.sol:Launchpad
///   forge verify-contract --chain 4441 --verifier blockscout \
///     --verifier-url https://liteforge.explorer.caldera.xyz/api/ --watch \
///     --constructor-args "$(cast abi-encode 'constructor(address,address)' <launchpad> "$UNIV2_ROUTER")" \
///     <migrator> src/UniV2Migrator.sol:UniV2Migrator
///   (and the TimelockController with (uint256 delay, address[] proposers, address[] executors, address 0),
///   the LaunchTokenFactory and the LaunchpadMigration with no arguments, as for Base: DeployBase.s.sol)
contract DeployLitVM is Script {
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    /// forge's stand-in sender outside a broadcast: never a proposer or a treasury.
    address constant FORGE_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// The account that signs the broadcast: known only once it started (before,
    /// msg.sender is forge's stand-in, which a deploy must never write anywhere).
    function _broadcaster() internal returns (address who) {
        (, who,) = vm.readCallers();
        require(who != FORGE_DEFAULT_SENDER && who != address(0), "no signer: pass --account or --private-key");
    }

    function run() external {
        address router = vm.envOr("UNIV2_ROUTER", address(0));
        uint256 nativeVirtual = vm.envOr("NATIVE_VIRTUAL", uint256(0));
        address operator = vm.envOr("MIGRATION_OPERATOR", address(0)); // may run a migration into this pad (v12)
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));
        bool deployerOwned = vm.envOr("DEPLOYER_OWNED", false); // a rehearsal pad: no timelock, the deployer's

        vm.startBroadcast();
        address treasury = vm.envOr("TREASURY", _broadcaster()); // the deployer, read from the broadcast itself
        require(treasury != FORGE_DEFAULT_SENDER, "TREASURY is forge's stand-in sender");
        address proposer = vm.envOr("PROPOSER", _broadcaster());
        require(proposer != FORGE_DEFAULT_SENDER, "PROPOSER is forge's stand-in sender");
        Launchpad pad = new Launchpad(treasury);
        if (router != address(0)) {
            UniV2Migrator migrator = new UniV2Migrator(address(pad), router);
            pad.setMigrator(address(migrator));
            console.log("UniV2Migrator:", address(migrator));
        }
        if (nativeVirtual != 0 && nativeVirtual != pad.VIRTUAL_ETH()) pad.setQuoteAsset(address(0), nativeVirtual);
        if (operator != address(0)) ILaunchpadMigration(address(pad)).setMigrationOperator(operator);
        address owner = _broadcaster();
        if (!deployerOwned) {
            // the timelock owns the pad from its first block: every owner call public for the delay
            address[] memory proposers = new address[](1);
            proposers[0] = proposer;
            address[] memory executors = new address[](2);
            executors[0] = proposer;
            executors[1] = address(0); // the open role: anyone may execute what is ready
            TimelockController timelock = new TimelockController(delay, proposers, executors, address(0));
            pad.transferOwnership(address(timelock));
            owner = address(timelock);
        }
        vm.stopBroadcast();

        console.log("Launchpad:    ", address(pad));
        console.log("LaunchpadMigration:", pad.MIGRATION_MODULE());
        console.log("Fee (bps):    ", pad.feeBps());
        if (operator != address(0)) console.log("Migration operator:", operator);
        console.log("Treasury:     ", treasury);
        if (deployerOwned) {
            console.log("Owner:         the deployer (DEPLOYER_OWNED: a rehearsal pad)");
        } else {
            console.log("Timelock (owner):", owner);
            console.log("Delay (s):    ", delay);
            console.log("Proposer:     ", proposer);
        }
        console.log("Native virtual (wei):", pad.quoteVirtualReserve(address(0)));
        console.log("Deploy block: ", block.number);
        if (router == address(0)) console.log("No UNIV2_ROUTER: graduation stays manual until setMigrator");
        if (MULTICALL3.code.length == 0) {
            console.log("No Multicall3 on this chain: the web app falls back to single reads (fine for a testnet)");
        }
    }
}
