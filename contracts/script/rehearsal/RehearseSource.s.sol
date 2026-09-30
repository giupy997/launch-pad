// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {UniV2Migrator} from "../../src/UniV2Migrator.sol";
import {MockCbLTC} from "../../test/mocks/MockCbLTC.sol";
import {MockWETH9, MockV2Factory, MockV2Router, MockV2Pair} from "../../test/mocks/UniV2Mock.sol";
import {Keys} from "./Keys.sol";

/// The source side of a local rehearsal (anvil): a pad quoted in a mock cbLTC,
/// two coins with three holders — one still on its curve, one graduated and
/// traded in its pool — and a freeze announced 40 blocks ahead. Writes what
/// the next steps need to rehearsal-source.json.
contract RehearseSource is Script {
    struct Env {
        MockCbLTC quote;
        MockWETH9 weth;
        MockV2Router router;
        Launchpad pad;
        UniV2Migrator migrator;
        address curveCoin;
        address gradCoin;
        uint256 freezeAt;
    }

    Env internal e;

    function run() external {
        _deploy();
        _trade();
        _freezeAndRecord();
    }

    function _deploy() internal {
        address deployer = vm.addr(Keys.DEPLOYER);
        vm.startBroadcast(Keys.DEPLOYER);
        e.quote = new MockCbLTC();
        e.weth = new MockWETH9();
        MockV2Factory factory = new MockV2Factory();
        e.router = new MockV2Router(address(factory), address(e.weth));
        e.pad = new Launchpad(deployer);
        e.migrator = new UniV2Migrator(address(e.pad), address(e.router));
        e.pad.setMigrator(address(e.migrator));
        e.pad.setQuoteAsset(address(e.quote), 30e8);
        e.pad.setQuoteAsset(address(0), 0); // as on Base: cbLTC alone
        e.quote.mint(vm.addr(Keys.ALICE), 10e8);
        e.quote.mint(vm.addr(Keys.BOB), 10e8);
        e.quote.mint(vm.addr(Keys.CAROL), 300e8);
        vm.stopBroadcast();
    }

    function _trade() internal {
        Launchpad.TokenMetadata memory meta = Launchpad.TokenMetadata("ipfs://logo", "", "", "", "", "");

        vm.startBroadcast(Keys.ALICE);
        // a coin with fees of its own: 3% tax each way, split creator / holders / burn / liquidity
        e.curveCoin = e.pad.createTokenWithFees(
            "Curve Coin", "CURVE", 0, meta, address(e.quote), Launchpad.FeeConfig(300, 300, 5000, 2000, 2000, 1000)
        );
        e.quote.approve(address(e.pad), 5e8);
        e.pad.buyWithQuote(e.curveCoin, 5e8, 0);
        vm.stopBroadcast();

        vm.startBroadcast(Keys.BOB);
        e.quote.approve(address(e.pad), 3e8);
        e.pad.buyWithQuote(e.curveCoin, 3e8, 0);
        e.pad.buybackAndBurn(e.curveCoin); // its burn pot spent: `burned` travels with the coin, the liquidity pot too
        vm.stopBroadcast();

        vm.startBroadcast(Keys.CAROL);
        e.gradCoin = e.pad.createToken("Grad Coin", "GRAD", 0, meta, address(e.quote), true);
        e.quote.approve(address(e.pad), 200e8);
        e.pad.buyWithQuote(e.gradCoin, 200e8, 0); // graduates: the curve raises ~96 cbLTC
        vm.stopBroadcast();

        _poolBuy();
    }

    /// bob buys GRAD from its pool after graduation: a holder the curve never saw.
    function _poolBuy() internal {
        address pair = e.migrator.pairOf(e.gradCoin);
        (uint112 r0, uint112 r1,) = MockV2Pair(pair).getReserves();
        bool tokenIsZero = MockV2Pair(pair).token0() == e.gradCoin;
        (uint256 rToken, uint256 rQuote) = tokenIsZero ? (r0, r1) : (r1, r0);
        uint256 quoteIn = 1e8;
        uint256 tokensOut = (quoteIn * 997 * rToken) / (rQuote * 1000 + quoteIn * 997);
        vm.startBroadcast(Keys.BOB);
        e.quote.transfer(pair, quoteIn);
        MockV2Pair(pair).swap(tokenIsZero ? tokensOut : 0, tokenIsZero ? 0 : tokensOut, vm.addr(Keys.BOB), "");
        vm.stopBroadcast();
    }

    function _freezeAndRecord() internal {
        e.freezeAt = block.number + 40;
        vm.startBroadcast(Keys.DEPLOYER);
        e.pad.announceFreeze(e.freezeAt);
        vm.stopBroadcast();

        string memory j = "source";
        vm.serializeAddress(j, "launchpad", address(e.pad));
        vm.serializeAddress(j, "quote", address(e.quote));
        vm.serializeAddress(j, "weth", address(e.weth));
        vm.serializeAddress(j, "router", address(e.router));
        vm.serializeAddress(j, "migrator", address(e.migrator));
        vm.serializeAddress(j, "curveCoin", e.curveCoin);
        vm.serializeAddress(j, "gradCoin", e.gradCoin);
        vm.serializeAddress(j, "cold", vm.addr(Keys.DEPLOYER));
        vm.writeJson(vm.serializeUint(j, "freezeBlock", e.freezeAt), Keys.SOURCE);

        console.log("source launchpad:", address(e.pad));
        console.log("quote (mock cbLTC):", address(e.quote));
        console.log("CURVE:", e.curveCoin);
        console.log("GRAD:", e.gradCoin);
        console.log("freeze announced for block", e.freezeAt);
    }
}
