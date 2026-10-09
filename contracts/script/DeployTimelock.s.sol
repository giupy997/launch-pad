// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TimelockController} from "openzeppelin-contracts/contracts/governance/TimelockController.sol";
import {Launchpad} from "../src/Launchpad.sol";

/// The Launchpad's owner becomes a timelock. Every owner call — fees and
/// their split, the treasury, the migrator, quote assets, the ledger
/// migration — is scheduled first, in the open on chain, and can only run
/// TIMELOCK_DELAY seconds later. PROPOSER (default: the broadcaster) may
/// schedule and cancel; anyone may execute an operation once it is ready.
///
///   TIMELOCK_DELAY=172800 LAUNCHPAD=0x... forge script script/DeployTimelock.s.sol \
///     --rpc-url litvm_testnet --account notus --broadcast
///
/// Without LAUNCHPAD the timelock is only deployed; hand it the Launchpad
/// later with `cast send <pad> "transferOwnership(address)" <timelock>`.
/// A rehearsal pad on the testnet takes a short delay (TIMELOCK_DELAY=600).
contract DeployTimelock is Script {
    /// forge's stand-in sender outside a broadcast: never a proposer or a treasury.
    address constant FORGE_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// The account that signs the broadcast: known only once it started (before,
    /// msg.sender is forge's stand-in, which a deploy must never write anywhere).
    function _broadcaster() internal returns (address who) {
        (, who,) = vm.readCallers();
        require(who != FORGE_DEFAULT_SENDER && who != address(0), "no signer: pass --account or --private-key");
    }

    function run() external {
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));
        address pad = vm.envOr("LAUNCHPAD", address(0));

        vm.startBroadcast();
        address proposer = vm.envOr("PROPOSER", _broadcaster()); // the deployer, read from the broadcast itself
        require(proposer != FORGE_DEFAULT_SENDER, "PROPOSER is forge's stand-in sender");
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](2);
        executors[0] = proposer;
        executors[1] = address(0); // the open role: anyone may execute what is ready
        TimelockController timelock = new TimelockController(delay, proposers, executors, address(0));
        if (pad != address(0)) Launchpad(payable(pad)).transferOwnership(address(timelock));
        vm.stopBroadcast();

        console.log("Timelock:     ", address(timelock));
        console.log("Delay (s):    ", delay);
        console.log("Proposer:     ", proposer);
        if (pad != address(0)) console.log("Now owns:     ", pad);
        console.log("Deploy block: ", block.number);
    }
}
