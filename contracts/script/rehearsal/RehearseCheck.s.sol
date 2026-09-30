// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {UniV2Migrator} from "../../src/UniV2Migrator.sol";
import {MigrateFromLedger} from "../MigrateFromLedger.s.sol";
import {MockV2Pair} from "../../test/mocks/UniV2Mock.sol";
import {Keys} from "./Keys.sol";

/// After the migration ran: every holder has the balance the snapshot recorded,
/// every curve stands at the frozen price, every graduated coin's pool too.
contract RehearseCheck is Script {
    function run() external {
        string memory json = vm.readFile(vm.envString("MIGRATION_FILE"));
        MigrateFromLedger.Coin[] memory coins = new MigrateFromLedger().load(json);
        string memory t = vm.readFile(Keys.TARGET);
        Launchpad pad = Launchpad(vm.parseJsonAddress(t, ".launchpad"));
        UniV2Migrator migrator = UniV2Migrator(payable(vm.parseJsonAddress(t, ".migrator")));

        for (uint256 i = 0; i < coins.length; i++) {
            address token = pad.migratedTicker(keccak256(bytes(coins[i].symbol)));
            require(token != address(0), string.concat(coins[i].symbol, ": not migrated"));
            require(pad.migrationPending(token) == 0, string.concat(coins[i].symbol, ": holders still pending"));
            _checkHolders(coins[i], token);
            if (coins[i].poolToken == 0) _checkCurve(pad, coins[i], token);
            else _checkPool(pad, migrator, coins[i], token);
        }
        console.log("ALL PASS:", coins.length, "coins re-created with the same holders and the same price");
    }

    function _checkHolders(MigrateFromLedger.Coin memory c, address token) internal view {
        uint256 owned;
        for (uint256 h = 0; h < c.holders.length; h++) {
            uint256 bal = IERC20(token).balanceOf(c.holders[h]);
            require(bal == c.balances[h], string.concat(c.symbol, ": a holder's balance differs"));
            owned += bal;
        }
        require(owned == c.sold, string.concat(c.symbol, ": holders do not add up to sold"));
    }

    function _checkCurve(Launchpad pad, MigrateFromLedger.Coin memory c, address token) internal view {
        (uint256 vEth, uint256 vToken,, uint256 sold, bool graduated,,) = pad.curves(token);
        require(!graduated, string.concat(c.symbol, ": graduated but should be on its curve"));
        require(sold == c.sold, "sold differs");
        uint256 price = (vEth * 1e18) / vToken;
        uint256 expected = ((c.virtualQuote + c.realQuote) * 1e18) / (pad.VIRTUAL_TOKEN() - c.sold);
        require(price == expected, string.concat(c.symbol, ": the curve price differs"));
        console.log(string.concat("PASS ", c.symbol, ": curve coin, holders and price as frozen;"), c.holders.length, "holders, price (wei/token)", price);
    }

    function _checkPool(Launchpad pad, UniV2Migrator migrator, MigrateFromLedger.Coin memory c, address token) internal view {
        (,,,, bool graduated,,) = pad.curves(token);
        require(graduated, string.concat(c.symbol, ": should have graduated"));
        address pair = migrator.pairOf(token);
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        (uint256 rToken, uint256 rQuote) = MockV2Pair(pair).token0() == token ? (r0, r1) : (r1, r0);
        // the pool price, within a tenth of a percent of the frozen one
        uint256 lhs = rQuote * c.poolToken;
        uint256 rhs = c.realQuote * rToken;
        uint256 tol = rhs / 1000;
        require(lhs + tol >= rhs && lhs <= rhs + tol, string.concat(c.symbol, ": the pool price differs"));
        console.log(string.concat("PASS ", c.symbol, ": graduated coin, holders and pool price as frozen;"), c.holders.length, "holders, pool quote (wei)", rQuote);
    }
}
