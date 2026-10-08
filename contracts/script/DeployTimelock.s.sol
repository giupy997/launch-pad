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
    function run() external {
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(48 hours));
        address proposer = vm.envOr("PROPOSER", msg.sender);
        address pad = vm.envOr("LAUNCHPAD", address(0));

        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](2);
        executors[0] = proposer;
        executors[1] = address(0); // the open role: anyone may execute what is ready

        vm.startBroadcast();
        TimelockController timelock = new TimelockController(delay, proposers, executors, address(0));
        if (pad != address(0)) Launchpad(pad).transferOwnership(address(timelock));
        vm.stopBroadcast();

        console.log("Timelock:     ", address(timelock));
        console.log("Delay (s):    ", delay);
        console.log("Proposer:     ", proposer);
        if (pad != address(0)) console.log("Now owns:     ", pad);
        console.log("Deploy block: ", block.number);
    }
}
