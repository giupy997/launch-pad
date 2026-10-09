// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {Launchpad} from "../../src/Launchpad.sol";
import {UniV2Migrator} from "../../src/UniV2Migrator.sol";
import {Keys} from "./Keys.sol";

interface IPairLike {
    function token0() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface IWETHLike {
    function deposit() external payable;
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// After a migrated coin arrived graduated (or graduated here): a buy and a
/// sell on its pool, straight on the pair the way a router does it, then a
/// harvest by a bystander and a wallet-to-wallet transfer — the v12 fees
/// checked at every step. The buyer receives the pair's output less the
/// coin's pool rate (the launchpad's 0.5% and its own buy tax), the pad's two
/// buckets grow by exactly the split, the harvest shrinks them, pays the
/// treasury and tips its caller, nothing stays in the migrator, and a plain
/// transfer pays nothing. Works on the mock DEX of the local rehearsal and
/// on the real Uniswap v2 of a Base fork alike.
///
///   SYMBOL=GRAD | TOKEN=0x... [QUOTE_IN=<units>] [MINT_QUOTE=true] \
///   forge script script/rehearsal/RehearseV12Pool.s.sol --rpc-url $RPC --broadcast
///
/// Reads the pad and migrator from rehearsal-target.json; the coin is a
/// migrated ticker (SYMBOL) or any graduated coin of the pad (TOKEN). The buyer is
/// Keys.BOB, the harvester Keys.CAROL (anvil's accounts); with an ERC-20
/// quote the buyer must hold QUOTE_IN of it (MINT_QUOTE=true mints it on the
/// mock cbLTC of the local rehearsal; on a fork, transfer it from a holder).
/// On a live testnet (Liteforge), where anvil's accounts hold nothing,
/// SINGLE_SIGNER=true makes the script's own signer (--account / --private-key)
/// play every part, and the transfer goes to a fixed stranger.
contract RehearseV12Pool is Script {
    /// Nobody's address: where the single signer's wallet-to-wallet transfer goes.
    address constant STRANGER = 0x000000000000000000000000000000000000bEEF;
    bool internal single;

    struct S {
        Launchpad pad;
        UniV2Migrator migrator;
        address token;
        address pair;
        address quote; // the ERC-20 the pair holds against the coin (WETH for a native quote)
        bool native;
        bool tokenIs0;
        uint16 platformBps;
        uint16 buyTax;
        uint16 sellTax;
    }

    S internal s;

    function run() external {
        string memory t = vm.readFile(Keys.TARGET);
        s.pad = Launchpad(payable(vm.parseJsonAddress(t, ".launchpad")));
        s.migrator = UniV2Migrator(payable(vm.parseJsonAddress(t, ".migrator")));
        single = vm.envOr("SINGLE_SIGNER", false);
        string memory symbol = vm.envOr("SYMBOL", string("GRAD"));
        s.token = vm.envOr("TOKEN", address(0));
        if (s.token == address(0)) s.token = s.pad.migratedTicker(keccak256(bytes(symbol)));
        require(s.token != address(0), "no such migrated ticker on this pad (or pass TOKEN)");
        (,,,, bool graduated,, address quote) = s.pad.curves(s.token);
        require(graduated, "not graduated: no pool to trade on");
        s.pair = s.migrator.pairOf(s.token);
        require(s.pair != address(0) && s.pad.taxedPool(s.token, s.pair), "the pool is not registered for the fee");
        s.native = quote == address(0);
        s.quote = s.native ? s.migrator.weth() : quote;
        s.tokenIs0 = IPairLike(s.pair).token0() == s.token;
        (s.buyTax, s.sellTax,,,,, s.platformBps) = s.pad.feeConfig(s.token);
        console.log("pool rates (bps): launchpad", s.platformBps, "buy tax", s.buyTax);
        console.log("                  sell tax", s.sellTax);

        uint256 quoteIn = vm.envOr("QUOTE_IN", s.native ? uint256(0.01 ether) : uint256(1e8));
        _buy(quoteIn);
        _sell();
        _harvest();
        _transfer();
        console.log(string.concat("POOL PASS ", symbol, ": a taxed buy and sell on the pool, a harvest, a free transfer"));
    }

    /// Who plays a part: anvil's account for that key, or the script's signer for every part.
    function _who(uint256 key) internal view returns (address) {
        return single ? msg.sender : vm.addr(key);
    }

    function _start(uint256 key) internal {
        if (single) vm.startBroadcast();
        else vm.startBroadcast(key);
    }

    function _reserves() internal view returns (uint256 rToken, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = IPairLike(s.pair).getReserves();
        (rToken, rQuote) = s.tokenIs0 ? (r0, r1) : (r1, r0);
    }

    function _buckets() internal view returns (uint256) {
        return s.pad.taxTreasury(s.token) + s.pad.taxPot(s.token);
    }

    /// bob pays `quoteIn` into the pair and takes the output: the coin keeps
    /// the pool rate of it for the pad.
    function _buy(uint256 quoteIn) internal {
        address bob = _who(Keys.BOB);
        (uint256 rToken, uint256 rQuote) = _reserves();
        uint256 out = (quoteIn * 997 * rToken) / (rQuote * 1000 + quoteIn * 997);
        uint256 rate = uint256(s.platformBps) + s.buyTax;
        uint256 tax = (out * rate) / 10_000;
        uint256 tT = s.pad.taxTreasury(s.token);
        uint256 tP = s.pad.taxPot(s.token);
        uint256 before = IERC20(s.token).balanceOf(bob);
        _start(Keys.BOB);
        if (s.native) IWETHLike(s.quote).deposit{value: quoteIn}();
        else if (vm.envOr("MINT_QUOTE", false)) IMintable(s.quote).mint(bob, quoteIn);
        IERC20(s.quote).transfer(s.pair, quoteIn);
        IPairLike(s.pair).swap(s.tokenIs0 ? out : 0, s.tokenIs0 ? 0 : out, bob, "");
        vm.stopBroadcast();
        uint256 got = IERC20(s.token).balanceOf(bob) - before;
        require(got == out - tax, "the buyer did not receive the pair's output less the pool rate");
        uint256 platform = rate == 0 ? 0 : (tax * s.platformBps) / rate;
        require(s.pad.taxTreasury(s.token) - tT == platform, "the launchpad's bucket did not grow by its part");
        require(s.pad.taxPot(s.token) - tP == tax - platform, "the coin's bucket did not grow by the rest");
        console.log("buy:  quote in", quoteIn, "coins out, net of the fee", got);
        console.log("      fee kept in coins", tax, "of which the launchpad's", platform);
    }

    /// bob sells half of what he got: the pair receives the coins net of the
    /// pool rate and pays for those.
    function _sell() internal {
        address bob = _who(Keys.BOB);
        uint256 amount = IERC20(s.token).balanceOf(bob) / 2;
        require(amount != 0, "nothing to sell");
        (uint256 rToken, uint256 rQuote) = _reserves();
        uint256 rate = uint256(s.platformBps) + s.sellTax;
        uint256 net = amount - (amount * rate) / 10_000;
        uint256 out = (net * 997 * rQuote) / (rToken * 1000 + net * 997);
        uint256 before = IERC20(s.quote).balanceOf(bob);
        uint256 buckets = _buckets();
        _start(Keys.BOB);
        IERC20(s.token).transfer(s.pair, amount);
        IPairLike(s.pair).swap(s.tokenIs0 ? 0 : out, s.tokenIs0 ? out : 0, bob, "");
        vm.stopBroadcast();
        require(IERC20(s.quote).balanceOf(bob) - before == out, "the seller did not get the pair's price for the net amount");
        require(_buckets() - buckets == amount - net, "the buckets did not grow by the sell fee");
        console.log("sell: coins in", amount, "of which the pair got", net);
        console.log("      quote out", out);
    }

    /// carol, who holds nothing of the coin, harvests: the buckets are sold,
    /// the treasury paid, carol tipped, the migrator left empty.
    function _harvest() internal {
        address carol = _who(Keys.CAROL);
        address treasury = s.pad.treasury();
        uint256 buckets = _buckets();
        require(buckets != 0, "nothing to harvest");
        uint256 treasuryBefore = _quoteBalance(treasury);
        uint256 carolBefore = _quoteBalance(carol);
        _start(Keys.CAROL);
        (uint256 tokensIn, uint256 quoteOut, uint256 burned) = s.migrator.harvest(s.token);
        vm.stopBroadcast();
        require(tokensIn != 0 && quoteOut != 0, "the harvest sold nothing");
        require(_buckets() == buckets - tokensIn, "the buckets did not shrink by the slice");
        // paid in the native coin, a treasury that is also the signer spends it on gas: checked when it is somebody else
        if (treasury != carol || !s.native) require(_quoteBalance(treasury) > treasuryBefore, "the treasury was not paid");
        // the tip: a native one is paid in the coin carol spends on gas, so it is checked on an ERC-20 quote alone
        if (!s.native) require(_quoteBalance(carol) > carolBefore, "the harvester was not tipped");
        require(IERC20(s.quote).balanceOf(address(s.migrator)) == 0 && address(s.migrator).balance == 0, "quote stranded in the migrator");
        console.log("harvest: coins sold", tokensIn, "quote out", quoteOut);
        console.log("         coins burned", burned);
    }

    /// A wallet-to-wallet transfer pays nothing.
    function _transfer() internal {
        address bob = _who(Keys.BOB);
        address carol = single ? STRANGER : vm.addr(Keys.CAROL);
        uint256 amount = IERC20(s.token).balanceOf(bob) / 10;
        uint256 before = IERC20(s.token).balanceOf(carol);
        uint256 buckets = _buckets();
        _start(Keys.BOB);
        IERC20(s.token).transfer(carol, amount);
        vm.stopBroadcast();
        require(IERC20(s.token).balanceOf(carol) - before == amount, "a wallet transfer was taxed");
        require(_buckets() == buckets, "a wallet transfer fed the buckets");
        console.log("transfer: wallet to wallet, whole", amount);
    }

    /// What `who` holds of the quote the pad pays out: the native coin itself
    /// (poolFee unwraps it) or the ERC-20.
    function _quoteBalance(address who) internal view returns (uint256) {
        return s.native ? who.balance : IERC20(s.quote).balanceOf(who);
    }
}
