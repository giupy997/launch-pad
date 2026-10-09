// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../src/Launchpad.sol";
import {UniV2Migrator} from "../src/UniV2Migrator.sol";
import {ILaunchpadMigration} from "../src/interfaces/ILaunchpadMigration.sol";

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
/// graduate. Mainnet opens with 50 zkLTC (50e18), Base v12's figure: 160
/// zkLTC to graduate, ~840 of market cap there. The pad stays owned by the
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

        vm.startBroadcast();
        address treasury = vm.envOr("TREASURY", _broadcaster()); // the deployer, read from the broadcast itself
        require(treasury != FORGE_DEFAULT_SENDER, "TREASURY is forge's stand-in sender");
        Launchpad pad = new Launchpad(treasury);
        if (router != address(0)) {
            UniV2Migrator migrator = new UniV2Migrator(address(pad), router);
            pad.setMigrator(address(migrator));
            console.log("UniV2Migrator:", address(migrator));
        }
        if (nativeVirtual != 0 && nativeVirtual != pad.VIRTUAL_ETH()) pad.setQuoteAsset(address(0), nativeVirtual);
        if (operator != address(0)) ILaunchpadMigration(address(pad)).setMigrationOperator(operator);
        vm.stopBroadcast();

        console.log("Launchpad:    ", address(pad));
        console.log("LaunchpadMigration:", pad.MIGRATION_MODULE());
        console.log("Fee (bps):    ", pad.feeBps());
        if (operator != address(0)) console.log("Migration operator:", operator);
        console.log("Treasury:     ", treasury);
        console.log("Native virtual (wei):", pad.quoteVirtualReserve(address(0)));
        console.log("Deploy block: ", block.number);
        if (router == address(0)) console.log("No UNIV2_ROUTER: graduation stays manual until setMigrator");
        if (MULTICALL3.code.length == 0) {
            console.log("No Multicall3 on this chain: the web app falls back to single reads (fine for a testnet)");
        }
    }
}
