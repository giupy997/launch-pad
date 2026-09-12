// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {NotusV4Hook} from "../src/NotusV4Hook.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {HookMiner} from "./HookMiner.sol";

/// Full Robinhood Chain deployment in one run: Launchpad, the Uniswap v4
/// graduation hook (address mined so its low bits encode its callbacks),
/// the wiring between them, and the ETH zap router.
/// Afterwards: LAUNCHPAD=<address> ./script/enable-rwa-quotes.sh
///             LAUNCHPAD=<address> ./script/create-pre-markets.sh
contract DeployRobinhood is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2; // Uniswap v3 SwapRouter02
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function run() external {
        address treasury = vm.envOr("TREASURY", msg.sender);
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );

        vm.startBroadcast();
        Launchpad pad = new Launchpad(treasury, POOL_MANAGER);

        (address expected, bytes32 salt) = HookMiner.find(
            CREATE2_FACTORY, flags, type(NotusV4Hook).creationCode, abi.encode(POOL_MANAGER, address(pad))
        );
        NotusV4Hook hook = new NotusV4Hook{salt: salt}(IPoolManager(POOL_MANAGER), address(pad));
        require(address(hook) == expected, "hook address mismatch");

        pad.setMigrator(address(hook));
        pad.authorizePoolFeeHook(address(hook));
        ZapRouter zap = new ZapRouter(address(pad), SWAP_ROUTER, WETH);
        vm.stopBroadcast();

        console.log("Launchpad:   ", address(pad));
        console.log("NotusV4Hook: ", address(hook));
        console.log("ZapRouter:   ", address(zap));
        console.log("Treasury:    ", treasury);
    }
}
