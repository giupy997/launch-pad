// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";

/// LitVM (Litecoin's EVM layer 2, Arbitrum Orbit): the Launchpad quoted in
/// native zkLTC, plus — when UNIV2_ROUTER is set — a Uniswap v2 graduation
/// adapter (LitVM's DEXes are v2 forks; there is no v4 PoolManager, so
/// holder rewards stop at graduation there, like on GIWA).
///
///   cd contracts && source .env && \
///   UNIV2_ROUTER=0x... [TREASURY=0x...] [NATIVE_VIRTUAL=<wei>] forge script script/DeployLitVM.s.sol \
///     --rpc-url litvm_testnet --account notus --broadcast
///
/// TREASURY defaults to the deployer. NATIVE_VIRTUAL is the virtual reserve
/// a native-quoted curve opens with, in wei of zkLTC (default the contract's
/// 1.25): a testnet short of zkLTC wants a small one, so that a curve can be
/// bought through graduation with faucet coins — 0.05 zkLTC raises 0.16 to
/// graduate. Mainnet opens with 60 zkLTC (60e18), Base's figure: 192 zkLTC
/// to graduate, 1,008 of market cap there. The pad stays owned by the
/// deployer: a rehearsal pad, or the migration day's pad, which the
/// TimelockController takes over right after (DeployTimelock.s.sol).
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
contract DeployLitVM is Script {
    address constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    function run() external {
        address treasury = vm.envOr("TREASURY", msg.sender);
        address router = vm.envOr("UNIV2_ROUTER", address(0));
        uint256 nativeVirtual = vm.envOr("NATIVE_VIRTUAL", uint256(0));

        vm.startBroadcast();
        Launchpad pad = new Launchpad(treasury);
        if (router != address(0)) {
            UniV2Migrator migrator = new UniV2Migrator(address(pad), router);
            pad.setMigrator(address(migrator));
            console.log("UniV2Migrator:", address(migrator));
        }
        if (nativeVirtual != 0 && nativeVirtual != pad.VIRTUAL_ETH()) pad.setQuoteAsset(address(0), nativeVirtual);
        vm.stopBroadcast();

        console.log("Launchpad:    ", address(pad));
        console.log("Treasury:     ", treasury);
        console.log("Native virtual (wei):", pad.quoteVirtualReserve(address(0)));
        console.log("Deploy block: ", block.number);
        if (router == address(0)) console.log("No UNIV2_ROUTER: graduation stays manual until setMigrator");
        if (MULTICALL3.code.length == 0) {
            console.log("No Multicall3 on this chain: the web app falls back to single reads (fine for a testnet)");
        }
    }
}
