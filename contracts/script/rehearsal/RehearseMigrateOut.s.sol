// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {ILaunchpadMigration} from "../../src/interfaces/ILaunchpadMigration.sol";
import {Keys} from "./Keys.sol";

/// Once the freeze landed: every coin's quote leaves for the bridging account.
contract RehearseMigrateOut is Script {
    function run() external {
        string memory j = vm.readFile(Keys.SOURCE);
        Launchpad pad = Launchpad(payable(vm.parseJsonAddress(j, ".launchpad")));
        IERC20 quote = IERC20(vm.parseJsonAddress(j, ".quote"));
        address cold = vm.parseJsonAddress(j, ".cold");
        require(pad.frozen(), "not frozen yet: mine past the freeze block first");
        uint256 before = quote.balanceOf(cold);
        vm.startBroadcast(Keys.DEPLOYER);
        (uint256 q1,) = ILaunchpadMigration(address(pad)).migrateOut(vm.parseJsonAddress(j, ".curveCoin"), cold);
        (uint256 q2, uint256 burned) = ILaunchpadMigration(address(pad)).migrateOut(vm.parseJsonAddress(j, ".gradCoin"), cold);
        vm.stopBroadcast();
        console.log("CURVE reserve out:", q1);
        console.log("GRAD pool out:", q2, "tokens burned:", burned);
        console.log("cold account received:", quote.balanceOf(cold) - before);
    }
}
