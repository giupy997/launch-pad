// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {ZapRouter} from "../src/ZapRouter.sol";

/// Base (chain 8453): the Launchpad quoted in cbLTC — Coinbase Wrapped LTC,
/// LTC 1:1 in Coinbase custody with a public proof of reserves, 8 decimals —
/// graduating into a locked Uniswap v2 pool (token/cbLTC), with one-transaction
/// ETH buys through PancakeSwap v3 (its SmartRouter shares SwapRouter02's
/// exactInput; cbLTC's pools live there and on Aerodrome, not on Uniswap v3).
/// The deployer owns the pad until DeployTimelock hands it to a timelock.
///
///   cd contracts && source .env && \
///   TREASURY=0x... [CBLTC_VIRTUAL=3000000000] forge script script/DeployBase.s.sol --rpc-url base \
///     --private-key "$PRIVATE_KEY" --broadcast
///
/// CBLTC_VIRTUAL is the virtual reserve a cbLTC curve opens with, in cbLTC
/// units (8 decimals): 30 cbLTC by default, the Litecoin ledger's own figure —
/// about $2K of opening market cap with LTC at $66, ~96 LTC raised to graduate.
///
/// Verify on Blockscout (base.blockscout.com) from this very checkout:
///   forge verify-contract --chain 8453 --verifier blockscout --verifier-url https://base.blockscout.com/api/ --watch \
///     --constructor-args "$(cast abi-encode 'constructor(address,address)' <treasury> 0x0000000000000000000000000000000000000000)" \
///     <launchpad> src/Launchpad.sol:Launchpad
///   … UniV2Migrator: 'constructor(address,address)' <launchpad> 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
///   … ZapRouter:     'constructor(address,address,address)' <launchpad> 0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86 0x4200000000000000000000000000000000000006
/// or by hand with `node script/standard-input.mjs …` (see that file).
contract DeployBase is Script {
    /// Coinbase Wrapped LTC on Base (8 decimals).
    address constant CBLTC = 0xcb17C9Db87B595717C857a08468793f5bAb6445F;
    /// Uniswap v2 Router02 on Base: the graduation pools.
    address constant UNIV2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    /// PancakeSwap v3 SmartRouter on Base: the ETH → cbLTC leg of a zap buy.
    address constant SWAP_ROUTER = 0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86;
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    function run() external {
        address treasury = vm.envOr("TREASURY", msg.sender);
        uint256 virtualReserve = vm.envOr("CBLTC_VIRTUAL", uint256(30 * 1e8));
        require(CBLTC.code.length > 0, "no cbLTC at its address: is this Base?");

        vm.startBroadcast();
        Launchpad pad = new Launchpad(treasury, address(0));
        UniV2Migrator migrator = new UniV2Migrator(address(pad), UNIV2_ROUTER);
        pad.setMigrator(address(migrator));
        pad.setQuoteAsset(CBLTC, virtualReserve);
        ZapRouter zap = new ZapRouter(address(pad), SWAP_ROUTER, WETH);
        vm.stopBroadcast();

        console.log("Launchpad:     ", address(pad));
        console.log("UniV2Migrator: ", address(migrator));
        console.log("ZapRouter:     ", address(zap));
        console.log("Treasury:      ", treasury);
        console.log("cbLTC virtual: ", virtualReserve, "(8 decimals)");
        console.log("Deploy block:  ", block.number);
        if (MULTICALL3.code.length == 0) console.log("No Multicall3 on this chain: the web app falls back to single reads");
    }
}
