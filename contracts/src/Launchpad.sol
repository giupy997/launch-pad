// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {LaunchpadBase} from "./LaunchpadBase.sol";
import {LaunchpadMigration} from "./LaunchpadMigration.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchTokenFactory} from "./LaunchTokenFactory.sol";
import {IDexMigrator, IDexMigratorBuyback} from "./interfaces/IDexMigrator.sol";

/// A pool of a coin, as the owner registers one: it names its two assets.
interface IPoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title Launchpad
/// @notice pump.fun-style launchpad: anyone creates a token, the full supply is
///         held by this contract and sold along a constant-product bonding
///         curve with virtual reserves. When the curve sells out, the token
///         "graduates": trading on the curve stops and the reserved supply plus
///         the raised quote migrate to a DEX via a pluggable adapter — and the
///         coin's fees go on there: every trade that touches its pool pays the
///         launchpad's fee and the coin's own tax in coins, which the adapter
///         harvests, sells and brings back here as quote for the same shares.
///
///         Curve math (virtual reserves x = quote, y = tokens, k = x * y):
///           buy:  tokensOut = y - k / (x + quoteIn)
///           sell: quoteOut  = x - k / (y + tokensIn)
///
///         The migration surface — from a ledger, to another launchpad — lives
///         in LaunchpadMigration and runs here by delegatecall (the fallback):
///         one storage, two runtimes, each under the size limit.
contract Launchpad is LaunchpadBase {
    using SafeERC20 for IERC20;

    /// The migration module, deployed here and fixed for good: every selector
    /// this contract lacks is run from it, in this contract's storage.
    address public immutable MIGRATION_MODULE;

    constructor(address treasury_) LaunchpadBase(treasury_) {
        tokenFactory = new LaunchTokenFactory();
        MIGRATION_MODULE = address(new LaunchpadMigration());
    }

    /// migrateToken, migrateBalances, setMigrationRoot, closeMigration,
    /// setMigrationOperator, announceFreeze, cancelFreeze, migrateOut: see
    /// LaunchpadMigration (ILaunchpadMigration for the ABI). Value only
    /// through them (migrateToken in a native quote); a bare transfer reverts.
    fallback() external payable {
        address module = MIGRATION_MODULE;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), module, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    // ---------------------------------------------------------------- create

    /// @notice Deploy a new token and open its curve. Sending ETH performs an
    ///         initial buy for the creator in the same transaction. No tax of
    ///         its own: the launchpad's fee alone, and `feesToHolders_` says
    ///         where a tax would have gone (nowhere, here: kept for the ABI).
    function createToken(
        string calldata name,
        string calldata symbol,
        uint256 minTokensOut,
        TokenMetadata calldata meta,
        address quoteAsset,
        bool feesToHolders_
    ) external payable nonReentrant returns (address token) {
        return _createToken(name, symbol, minTokensOut, meta, quoteAsset, _defaultFees(feesToHolders_));
    }

    /// @notice Deploy a new token with its own fee configuration (see
    ///         FeeConfig): its tax on buys and sells, at most MAX_TAX_BPS
    ///         each, and how that tax is split, fixed forever. Sending ETH
    ///         performs an initial buy for the creator in the same transaction.
    function createTokenWithFees(
        string calldata name,
        string calldata symbol,
        uint256 minTokensOut,
        TokenMetadata calldata meta,
        address quoteAsset,
        FeeConfig calldata fees
    ) external payable nonReentrant returns (address token) {
        return _createToken(name, symbol, minTokensOut, meta, quoteAsset, fees);
    }

    function _createToken(
        string calldata name,
        string calldata symbol,
        uint256 minTokensOut,
        TokenMetadata calldata meta,
        address quoteAsset,
        FeeConfig memory fees
    ) internal returns (address token) {
        // announced or landed, a freeze closes the pad to new coins: the list
        // of coins that move to the other launchpad is final from the announcement
        if (freezeBlock != 0) revert CreationClosed();
        uint256 vQuote = quoteVirtualReserve[quoteAsset];
        if (vQuote == 0) revert QuoteAssetNotEnabled();
        token = tokenFactory.create(name, symbol, TOTAL_SUPPLY);
        curves[token] = Curve({
            vEth: vQuote,
            vToken: VIRTUAL_TOKEN,
            realEth: 0,
            sold: 0,
            graduated: false,
            creator: msg.sender,
            quoteAsset: quoteAsset
        });
        tokenMetadata[token] = meta;
        _setFees(token, fees);
        allTokens.push(token);
        emit TokenCreated(token, msg.sender, name, symbol, fees.holdersBps != 0);
        emit MetadataUpdated(token);

        if (quoteAsset == address(0)) {
            if (msg.value > 0) _buy(token, msg.sender, msg.value, minTokensOut);
        } else if (msg.value > 0) {
            revert WrongPayment();
        }
    }

    /// The launch-time choice before taxes: a tax-less coin, its (empty) shares to holders or to the creator.
    function _defaultFees(bool toHolders) internal pure returns (FeeConfig memory) {
        return FeeConfig(0, 0, toHolders ? 0 : 10_000, toHolders ? 10_000 : 0, 0, 0, 0);
    }

    /// @notice Whether holders earn cashback on this coin (a holders share above zero).
    function feesToHolders(address token) external view returns (bool) {
        return feeConfig[token].holdersBps != 0;
    }

    /// @notice Buy on an ERC-20 quoted curve, paying from msg.sender.
    function buyWithQuote(address token, uint256 amountIn, uint256 minTokensOut) external nonReentrant {
        _buyWithQuote(token, amountIn, minTokensOut, msg.sender);
    }

    /// @notice Buy on an ERC-20 quoted curve for `recipient`: the quote is
    ///         pulled from msg.sender, tokens/refunds/cashback go to the
    ///         recipient. Lets routers zap ETH -> quote -> curve in one tx.
    function buyWithQuoteFor(address token, uint256 amountIn, uint256 minTokensOut, address recipient)
        external
        nonReentrant
    {
        _buyWithQuote(token, amountIn, minTokensOut, recipient);
    }

    function _buyWithQuote(address token, uint256 amountIn, uint256 minTokensOut, address recipient) internal {
        if (amountIn == 0) revert ZeroAmount();
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (c.quoteAsset == address(0)) revert WrongPayment();
        IERC20(c.quoteAsset).safeTransferFrom(msg.sender, address(this), amountIn);
        _buy(token, recipient, amountIn, minTokensOut);
    }

    /// @notice Redirect this token's creator fee share to another wallet
    ///         (address(0) resets to the creator). Creator only.
    function setFeeRecipient(address token, address recipient) external {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (msg.sender != c.creator) revert NotCreator();
        feeRecipient[token] = recipient;
        emit FeeRecipientUpdated(token, recipient);
    }

    /// @notice The token creator can update logo and links at any time.
    function updateMetadata(address token, TokenMetadata calldata meta) external {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (msg.sender != c.creator) revert NotCreator();
        tokenMetadata[token] = meta;
        emit MetadataUpdated(token);
    }

    // ---------------------------------------------------------------- trade

    function buy(address token, uint256 minTokensOut) external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        if (curves[token].quoteAsset != address(0)) revert WrongPayment();
        _buy(token, msg.sender, msg.value, minTokensOut);
    }

    function _buy(address token, address buyer, uint256 ethIn, uint256 minTokensOut) internal {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
        if (migrationPending[token] != 0) revert MigrationPending();
        if (frozen()) revert Frozen();

        FeeConfig storage cfg = feeConfig[token];
        uint256 f = uint256(cfg.platformBps) + cfg.buyTaxBps; // the launchpad's fee and the coin's own tax
        uint256 fee = (ethIn * f) / FEE_DENOMINATOR;
        uint256 ethForCurve = ethIn - fee;

        uint256 tokensOut = c.vToken - (c.vEth * c.vToken) / (c.vEth + ethForCurve);

        // Cap the final buy to what's left on the curve and refund the surplus.
        uint256 remaining = CURVE_SUPPLY - c.sold;
        uint256 refund = 0;
        if (tokensOut >= remaining) {
            tokensOut = remaining;
            // quote needed to buy exactly `remaining`: x' = k / (y - out) - x
            uint256 ethNeeded = (c.vEth * c.vToken) / (c.vToken - tokensOut) - c.vEth + 1; // round against user
            if (ethNeeded < ethForCurve) ethForCurve = ethNeeded;
            fee = (ethForCurve * f) / (FEE_DENOMINATOR - f); // fee on the used part
            // Rounding in the fee gross-up can exceed ethIn by a wei: that wei
            // comes off the fee, never out of the pad's other pots, and the
            // graduating buy never reverts here.
            refund = ethForCurve + fee; // the total, for a moment
            if (refund > ethIn) {
                fee -= refund - ethIn;
                refund = ethIn;
            }
            refund = ethIn - refund;
        }
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage();

        c.vEth += ethForCurve;
        c.vToken -= tokensOut;
        c.realEth += ethForCurve;
        c.sold += tokensOut;

        IERC20(token).safeTransfer(buyer, tokensOut);
        _splitFee(token, c.creator, c.quoteAsset, fee, f);
        if (refund > 0) _payOut(c.quoteAsset, buyer, refund);

        emit Bought(token, buyer, ethIn - refund, tokensOut, fee);

        if (c.sold == CURVE_SUPPLY) _graduate(token, c);
    }

    function sell(address token, uint256 tokensIn, uint256 minEthOut) external nonReentrant {
        if (tokensIn == 0) revert ZeroAmount();
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
        if (migrationPending[token] != 0) revert MigrationPending();
        if (frozen()) revert Frozen();

        uint256 k = c.vEth * c.vToken;
        uint256 ethOut = c.vEth - k / (c.vToken + tokensIn);
        // Rounding can push ethOut a wei past what the curve actually holds.
        if (ethOut > c.realEth) ethOut = c.realEth;
        FeeConfig storage cfg = feeConfig[token];
        uint256 f = uint256(cfg.platformBps) + cfg.sellTaxBps;
        uint256 fee = (ethOut * f) / FEE_DENOMINATOR;
        uint256 ethToSeller = ethOut - fee;
        if (ethToSeller < minEthOut) revert Slippage();

        c.vEth -= ethOut;
        c.vToken += tokensIn;
        c.realEth -= ethOut;
        c.sold -= tokensIn;

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        _splitFee(token, c.creator, c.quoteAsset, fee, f);
        _payOut(c.quoteAsset, msg.sender, ethToSeller);

        emit Sold(token, msg.sender, tokensIn, ethToSeller, fee);
    }

    // ---------------------------------------------------------------- views

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    // ---------------------------------------------------------------- migrate

    /// @notice After graduation anyone can trigger the migration: the reserved
    ///         supply and the raised quote are handed to the DEX adapter.
    function migrate(address token) external nonReentrant {
        _doMigrate(token);
    }

    // ---------------------------------------------------------------- fees

    /// @notice Splits a curve trade fee (see _accrueFee); the treasury share
    ///         is paid straight out.
    function _splitFee(address token, address creator, address asset, uint256 fee, uint256 f) internal {
        _payOut(asset, treasury, _accrueFee(token, creator, asset, fee, f));
    }

    /// @notice Accrues a fee taken at the rate `f` (the launchpad's fee and
    ///         the coin's tax together): the launchpad's part is the
    ///         treasury's, whole; the rest is the coin's tax, split as its
    ///         FeeConfig says — to the creator (pull-withdrawal), to holders
    ///         as cashback (pull-withdrawal; to the treasury while there is
    ///         no eligible supply), to the burn pot, and to the liquidity
    ///         pot. Returns the treasury share, rounding dust included.
    function _accrueFee(address token, address creator, address asset, uint256 fee, uint256 f)
        internal
        returns (uint256 toTreasury)
    {
        if (fee == 0) return 0;
        uint256 platform = (fee * feeConfig[token].platformBps) / f;
        toTreasury = platform + _splitPot(token, creator, asset, fee - platform);
    }

    /// @notice Spend a coin's burn pot: buy the coin back — on its curve, or on
    ///         its pool once graduated — and burn what comes out, so the supply
    ///         shrinks for everyone who holds it. Anyone may call it, once a
    ///         block per coin, and each call spends a slice at most — a
    ///         hundredth of the curve's virtual reserve, or what the pool's
    ///         adapter allows (a two-hundredth of its quote side) — so a trade
    ///         wrapped around the buy earns less than its fees cost, and the
    ///         pot goes out small and often rather than in one move anyone
    ///         could front-run.
    function buybackAndBurn(address token) external nonReentrant returns (uint256 tokensBurned) {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (migrationPending[token] != 0) revert MigrationPending();
        if (frozen()) revert Frozen();
        if (block.number < nextBurnBlock[token]) revert BurnCooldown();
        nextBurnBlock[token] = block.number + 1;
        uint256 pot = burnPot[token];
        if (pot == 0) revert ZeroAmount();
        uint256 used = pot;
        if (!c.graduated) {
            // a buy on the curve, with no fee: a slice of the pot, up to what is left on the curve
            if (used > c.vEth / 100) used = c.vEth / 100;
            uint256 k = c.vEth * c.vToken;
            tokensBurned = c.vToken - k / (c.vEth + used);
            uint256 remaining = CURVE_SUPPLY - c.sold;
            if (tokensBurned >= remaining) {
                tokensBurned = remaining;
                uint256 need = k / (c.vToken - remaining) - c.vEth + 1;
                if (need < used) used = need;
            }
            if (tokensBurned == 0) revert ZeroAmount();
            burnPot[token] = pot - used;
            c.vEth += used;
            c.vToken -= tokensBurned;
            c.realEth += used;
            c.sold += tokensBurned;
        } else {
            IDexMigrator via = graduatedVia[token];
            if (address(via) == address(0)) revert MigratorNotSet(); // graduated with no pool yet: nothing to buy from
            uint256 cap = IDexMigratorBuyback(address(via)).buybackCap(token);
            if (used > cap) used = cap;
            if (used == 0) revert ZeroAmount();
            burnPot[token] = pot - used;
            if (c.quoteAsset == address(0)) {
                tokensBurned = IDexMigratorBuyback(address(via)).buyback{value: used}(token, used);
            } else {
                IERC20(c.quoteAsset).safeTransfer(address(via), used);
                tokensBurned = IDexMigratorBuyback(address(via)).buyback(token, used);
            }
        }
        burned[token] += tokensBurned;
        LaunchToken(token).burn(tokensBurned);
        emit BoughtBack(token, used, tokensBurned);
        if (!c.graduated && c.sold == CURVE_SUPPLY) _graduate(token, c);
    }

    // ------------------------------------------------------ fees on the pool

    /// @notice What a transfer of `token` from `from` to `to` pays, in basis
    ///         points: the launchpad's fee and the coin's tax when the pool
    ///         pays out (a buy) or is paid (a sell), nothing otherwise — a
    ///         coin on its curve, a wallet-to-wallet move, the launchpad's
    ///         own moves and its migrator's, a coin that left. The token asks
    ///         before every transfer; the call reverts Frozen while the
    ///         launchpad stands still for a migration, except for what may
    ///         still move then: the launchpad's own transfers, the coin whose
    ///         pool is being unlocked, and withdrawals from the pool a coin
    ///         migrated out of.
    function transferRate(address token, address from, address to) external view returns (uint256 rateBps) {
        if (frozen() && from != address(this)) {
            address u = unlocking;
            if (!((u != address(0) && token == u) || (migratedOut[token] && from == migratedPair[token]))) {
                revert Frozen();
            }
            return 0;
        }
        if (!curves[token].graduated || migratedOut[token]) return 0;
        address via = address(graduatedVia[token]);
        if (from == address(this) || to == address(this) || from == via || to == via) return 0;
        FeeConfig storage f = feeConfig[token];
        if (taxedPool[token][from]) return uint256(f.platformBps) + f.buyTaxBps; // the pool pays out: a buy
        if (taxedPool[token][to]) return uint256(f.platformBps) + f.sellTaxBps; // the pool is paid: a sell
        return 0;
    }

    /// @notice The token took `amount` of itself as the fee on a pool trade
    ///         from `from` to `to` and sent it here: booked at once at the
    ///         rate the token applied, the launchpad's part by platformBps,
    ///         the rest the coin's. The harvest sells it later. Called by
    ///         the token inside the trade, so it only touches its own counters.
    function onTax(address from, address to, uint256 amount) external {
        address token = msg.sender;
        if (curves[token].vEth == 0) revert UnknownToken();
        FeeConfig storage f = feeConfig[token];
        bool isBuy = taxedPool[token][from];
        uint256 rate = uint256(f.platformBps) + (isBuy ? f.buyTaxBps : f.sellTaxBps);
        if (rate == 0 || (!isBuy && !taxedPool[token][to])) revert BadHarvest();
        uint256 platform = (amount * f.platformBps) / rate;
        taxTreasury[token] += platform;
        taxPot[token] += amount - platform;
        emit Taxed(token, isBuy, amount);
    }

    /// @notice The coin's migrator takes a slice of the taxed coins to sell:
    ///         `fromTreasury` of the launchpad's bucket, `fromPot` of the
    ///         coin's, of which `toBurn` — the burn share — is burned here,
    ///         no sale needed; the rest goes to the migrator to be sold.
    function takeTax(address token, uint256 fromTreasury, uint256 fromPot, uint256 toBurn)
        external
        nonReentrant
        returns (uint256 toSell)
    {
        if (msg.sender != address(graduatedVia[token]) || msg.sender == address(0)) revert NotMigrator();
        if (frozen()) revert Frozen();
        taxTreasury[token] -= fromTreasury; // more than the bucket holds reverts here
        taxPot[token] -= fromPot;
        if (toBurn > fromPot) revert BadHarvest();
        if (toBurn != 0) {
            burned[token] += toBurn;
            LaunchToken(token).burn(toBurn);
        }
        toSell = fromTreasury + fromPot - toBurn;
        if (toSell != 0) IERC20(token).safeTransfer(msg.sender, toSell);
    }

    /// @notice The quote a harvest realised, by destination: the treasury is
    ///         paid, the creator's and the holders' shares are booked as a
    ///         curve fee's would be, the burn-pot share waits for
    ///         buybackAndBurn (the liquidity share lands there when the
    ///         migrator could not add it to the pool). An ERC-20 quote was
    ///         transferred here before the call; a native one is msg.value.
    function poolFee(address token, uint256 toTreasury, uint256 toCreator, uint256 toHolders, uint256 toBurnPot)
        external
        payable
        nonReentrant
    {
        if (msg.sender != address(graduatedVia[token]) || msg.sender == address(0)) revert NotMigrator();
        Curve storage c = curves[token];
        uint256 total = toTreasury + toCreator + toHolders + toBurnPot;
        if (c.quoteAsset == address(0) ? msg.value != total : msg.value != 0) revert WrongPayment();
        burnPot[token] += toBurnPot;
        _payOut(c.quoteAsset, treasury, toTreasury + _creditShares(token, c.creator, c.quoteAsset, toCreator, toHolders));
        emit PoolFee(token, toTreasury, toCreator, toHolders, toBurnPot);
    }

    /// @notice Owner only (a timelock: public a delay ahead): another pool
    ///         of a graduated coin is taxed from now on and earns no cashback.
    ///         The address must be a pool of this coin — it names the coin as
    ///         one of its two assets — so no wallet can ever be registered.
    function registerTaxedPool(address token, address pool) external onlyOwner {
        if (!curves[token].graduated) revert NotYetGraduated();
        if (pool.code.length == 0 || (IPoolLike(pool).token0() != token && IPoolLike(pool).token1() != token)) {
            revert BadPool();
        }
        _registerPool(token, pool);
    }

    // ---------------------------------------------------------------- cashback

    /// @notice Transfer hook called by LaunchTokens right after every balance
    ///         change: harvests each wallet's accrual at its pre-transfer
    ///         balance, re-anchors its debt at the new balance and keeps the
    ///         eligible supply in sync, so cashback stays pro-rata forever.
    ///         Unknown callers only touch their own isolated storage keys and
    ///         can never mint claims (their accumulator is always zero).
    function onTokenTransfer(address from, address to, uint256 value) external {
        address token = msg.sender;
        bool fromEligible = _isEligible(token, from);
        bool toEligible = _isEligible(token, to);

        if (from == to) {
            // Moves nothing. Settling both sides would harvest `value` twice
            // off an inflated "old balance" — free cashback on every call.
            if (fromEligible) {
                uint256 bal = IERC20(token).balanceOf(from);
                _settleCashback(token, from, bal, bal);
            }
            return;
        }

        if (fromEligible) {
            uint256 newBal = IERC20(token).balanceOf(from);
            _settleCashback(token, from, newBal + value, newBal);
        }
        if (toEligible) {
            uint256 newBal = IERC20(token).balanceOf(to);
            _settleCashback(token, to, newBal - value, newBal);
        }
        if (fromEligible && !toEligible) eligibleSupply[token] -= value;
        else if (!fromEligible && toEligible) eligibleSupply[token] += value;
    }

    /// @notice Live claimable cashback for a holder of `token`. An account that
    ///         earns none — this contract, a registered pool, the coin's
    ///         migrator — has only what accrued before it stopped earning: the
    ///         holders' share is spread over the eligible supply alone, so its
    ///         balance times the accumulator is money held for the holders.
    function cashbackOf(address token, address holder) external view returns (uint256) {
        uint256 pending = pendingCashback[token][holder];
        if (!_isEligible(token, holder)) return pending;
        uint256 entitled = Math.mulDiv(IERC20(token).balanceOf(holder), accCashbackPerShare[token], ACC_PRECISION);
        uint256 debt = cashbackDebt[token][holder];
        return pending + (entitled > debt ? entitled - debt : 0);
    }

    /// @notice Withdraw the trade-fee cashback earned by holding `token`.
    function claimCashback(address token) external nonReentrant {
        uint256 bal = _isEligible(token, msg.sender) ? IERC20(token).balanceOf(msg.sender) : 0;
        _settleCashback(token, msg.sender, bal, bal);
        uint256 amount = pendingCashback[token][msg.sender];
        if (amount == 0) revert ZeroAmount();
        pendingCashback[token][msg.sender] = 0;
        _payOut(curves[token].quoteAsset, msg.sender, amount);
        emit CashbackClaimed(token, msg.sender, amount);
    }

    /// @notice Withdraw the creator fees accrued in `asset` (address(0) = ETH).
    function claimCreatorFees(address asset) external nonReentrant {
        uint256 amount = creatorFees[msg.sender][asset];
        if (amount == 0) revert ZeroAmount();
        creatorFees[msg.sender][asset] = 0;
        _payOut(asset, msg.sender, amount);
        emit CreatorFeesClaimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------- admin

    /// @notice The launchpad's fee for coins created from now on; a live
    ///         coin keeps the rate it launched with.
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeUpdated(newFeeBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Enable (virtualReserve > 0) or disable (0) a quote asset for
    ///         new curves (address(0) = native). The virtual reserve sizes
    ///         the curve in that asset's units (like 1.25 ETH does for native curves).
    function setQuoteAsset(address asset, uint256 virtualReserve) external onlyOwner {
        quoteVirtualReserve[asset] = virtualReserve;
        emit QuoteAssetUpdated(asset, virtualReserve);
    }

    function setMigrator(address newMigrator) external onlyOwner {
        migrator = IDexMigrator(newMigrator);
        emit MigratorUpdated(newMigrator);
    }
}
