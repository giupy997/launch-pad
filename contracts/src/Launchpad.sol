// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {IDexMigrator} from "./interfaces/IDexMigrator.sol";

/// @title Launchpad
/// @notice pump.fun-style launchpad: anyone creates a token, the full supply is
///         held by this contract and sold along a constant-product bonding
///         curve with virtual reserves. When the curve sells out, the token
///         "graduates": trading on the curve stops and the reserved supply plus
///         the raised ETH migrate to a DEX via a pluggable adapter.
///
///         Curve math (virtual reserves x = ETH, y = tokens, k = x * y):
///           buy:  tokensOut = y - k / (x + ethIn)
///           sell: ethOut    = x - k / (y + tokensIn)
contract Launchpad is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- config

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18; // 1B per token
    uint256 public constant CURVE_SUPPLY = 800_000_000e18; //   800M sold on curve
    uint256 public constant DEX_RESERVE = TOTAL_SUPPLY - CURVE_SUPPLY; // 200M for DEX

    /// virtual reserves at curve start; they set the initial price and the
    /// total ETH the curve raises (~ VIRTUAL_ETH * CURVE_SUPPLY / VIRTUAL_TOKEN
    /// at completion). With 1.25 ETH / 1.05B tokens the curve raises ~4 ETH.
    uint256 public constant VIRTUAL_ETH = 1.25 ether;
    uint256 public constant VIRTUAL_TOKEN = 1_050_000_000e18;

    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public feeBps = 100; // 1% on buys and sells
    /// Fee split: creatorFeeShareBps + holderCashbackBps form one pot that
    /// goes ENTIRELY to the creator or ENTIRELY to the holders, per the
    /// token's launch-time `feesToHolders` choice; the remainder goes to the
    /// treasury. Creator fees and cashback are pull-based (claim functions),
    /// so no external address can ever block trades.
    uint256 public creatorFeeShareBps = 5_000;
    uint256 public holderCashbackBps = 3_000;
    address public treasury;
    IDexMigrator public migrator;

    /// Creator fee accruals per recipient per asset (address(0) = ETH).
    mapping(address recipient => mapping(address asset => uint256)) public creatorFees;

    /// Quote assets enabled for new curves: virtual reserve per asset
    /// (position-sizes the curve in that asset's units/decimals). 0 = disabled.
    mapping(address asset => uint256) public quoteVirtualReserve;

    /// Holder cashback: a per-token rewards accumulator (1e30 precision — high
    /// enough that low-decimal quote assets like 6-decimal stables never round
    /// the per-share increment to zero against 1e18-decimal token supplies).
    /// Every balance change settles the affected wallets via the token's
    /// transfer hook, so pro-rata accounting stays exact even after
    /// graduation when transfers are free.
    uint256 private constant ACC_PRECISION = 1e30;
    mapping(address token => uint256) public accCashbackPerShare;
    mapping(address token => mapping(address holder => uint256)) public pendingCashback;
    mapping(address token => mapping(address holder => uint256)) public cashbackDebt;

    // ---------------------------------------------------------------- state

    struct Curve {
        uint256 vEth; //     virtual quote reserve (ETH or the quote asset)
        uint256 vToken; //   virtual token reserve
        uint256 realEth; //  quote actually held for this curve
        uint256 sold; //     tokens sold so far
        bool graduated;
        address creator;
        address quoteAsset; // address(0) = native ETH, else whitelisted ERC-20
    }

    /// Off-chain presentation data, stored on-chain so the frontend needs no
    /// indexer. logoURI should point to a square (1:1) image; livestream is
    /// the URL of the creator's live broadcast (empty = not live).
    struct TokenMetadata {
        string logoURI;
        string website;
        string twitter;
        string telegram;
        string livestream;
        string description;
    }

    mapping(address token => Curve) public curves;
    mapping(address token => TokenMetadata) public tokenMetadata;
    /// Per-token override for where the creator share of fees accrues.
    /// address(0) = the token's creator.
    mapping(address token => address) public feeRecipient;
    /// Launch-time fee destination, immutable so buyers can rely on it:
    /// true = the whole creator+holders pot is holder cashback, false = it
    /// all accrues to the creator.
    mapping(address token => bool) public feesToHolders;
    address[] public allTokens;

    // ---------------------------------------------------------------- events

    event TokenCreated(
        address indexed token, address indexed creator, string name, string symbol, bool feesToHolders
    );
    event MetadataUpdated(
        address indexed token, string logoURI, string website, string twitter, string telegram, string livestream
    );
    event AutoMigrationFailed(address indexed token);
    event FeeRecipientUpdated(address indexed token, address indexed recipient);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee);
    event Graduated(address indexed token, uint256 raisedEth);
    event Migrated(address indexed token, uint256 tokenAmount, uint256 ethAmount);
    event FeeUpdated(uint256 feeBps);
    event CreatorFeeShareUpdated(uint256 creatorFeeShareBps);
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event CashbackClaimed(address indexed token, address indexed holder, uint256 amount);
    event FeeSplitUpdated(uint256 creatorFeeShareBps, uint256 holderCashbackBps);
    event TreasuryUpdated(address treasury);
    event MigratorUpdated(address migrator);
    event QuoteAssetUpdated(address indexed asset, uint256 virtualReserve);

    // ---------------------------------------------------------------- errors

    error UnknownToken();
    error NotCreator();
    error AlreadyGraduated();
    error NotYetGraduated();
    error ZeroAmount();
    error Slippage();
    error FeeTooHigh();
    error MigratorNotSet();
    error EthTransferFailed();
    error QuoteAssetNotEnabled();
    error WrongPayment();

    constructor(address treasury_) Ownable(msg.sender) {
        treasury = treasury_;
    }

    // ---------------------------------------------------------------- create

    /// @notice Deploy a new token and open its curve. Sending ETH performs an
    ///         initial buy for the creator in the same transaction.
    ///         `feesToHolders_` fixes the fee destination forever: true sends
    ///         the whole creator+holders pot to holders as cashback, false
    ///         keeps it all for the creator.
    function createToken(
        string calldata name,
        string calldata symbol,
        uint256 minTokensOut,
        TokenMetadata calldata meta,
        address quoteAsset,
        bool feesToHolders_
    ) external payable nonReentrant returns (address token) {
        uint256 vQuote = VIRTUAL_ETH;
        if (quoteAsset != address(0)) {
            vQuote = quoteVirtualReserve[quoteAsset];
            if (vQuote == 0) revert QuoteAssetNotEnabled();
        }
        token = address(new LaunchToken(name, symbol, TOTAL_SUPPLY));
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
        if (feesToHolders_) feesToHolders[token] = true;
        allTokens.push(token);
        emit TokenCreated(token, msg.sender, name, symbol, feesToHolders_);
        emit MetadataUpdated(token, meta.logoURI, meta.website, meta.twitter, meta.telegram, meta.livestream);

        if (quoteAsset == address(0)) {
            if (msg.value > 0) _buy(token, msg.sender, msg.value, minTokensOut);
        } else if (msg.value > 0) {
            revert WrongPayment();
        }
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
        emit MetadataUpdated(token, meta.logoURI, meta.website, meta.twitter, meta.telegram, meta.livestream);
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

        uint256 fee = (ethIn * feeBps) / FEE_DENOMINATOR;
        uint256 ethForCurve = ethIn - fee;

        uint256 k = c.vEth * c.vToken;
        uint256 tokensOut = c.vToken - k / (c.vEth + ethForCurve);

        // Cap the final buy to what's left on the curve and refund the surplus.
        uint256 remaining = CURVE_SUPPLY - c.sold;
        uint256 refund = 0;
        if (tokensOut >= remaining) {
            tokensOut = remaining;
            // ETH needed to buy exactly `remaining`: x' = k / (y - out) - x
            uint256 ethNeeded = k / (c.vToken - tokensOut) - c.vEth + 1; // round against user
            if (ethNeeded < ethForCurve) {
                refund = ethForCurve - ethNeeded;
                ethForCurve = ethNeeded;
            }
            fee = (ethForCurve * feeBps) / (FEE_DENOMINATOR - feeBps); // fee on the used part
            // Rounding in the fee gross-up can exceed ethIn by a wei: saturate
            // instead of underflowing, so the graduating buy can never revert here.
            uint256 total = ethForCurve + fee;
            refund = ethIn > total ? ethIn - total : 0;
        }
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert Slippage();

        c.vEth += ethForCurve;
        c.vToken -= tokensOut;
        c.realEth += ethForCurve;
        c.sold += tokensOut;

        IERC20(token).safeTransfer(buyer, tokensOut);
        _splitFee(token, c.creator, c.quoteAsset, fee);
        if (refund > 0) _payOut(c.quoteAsset, buyer, refund);

        emit Bought(token, buyer, ethIn - refund, tokensOut, fee);

        if (c.sold == CURVE_SUPPLY) {
            c.graduated = true;
            LaunchToken(token).setGraduated();
            emit Graduated(token, c.realEth);
            // Auto-migrate to the DEX in the same transaction. The external
            // self-call isolates state: if the DEX leg reverts for any reason
            // the graduation itself still succeeds and migrate() stays
            // available as a manual fallback.
            if (address(migrator) != address(0)) {
                try this.autoMigrate(token) {}
                catch {
                    emit AutoMigrationFailed(token);
                }
            }
        }
    }

    /// @notice Self-call target for automatic graduation migration.
    function autoMigrate(address token) external {
        if (msg.sender != address(this)) revert NotCreator();
        _doMigrate(token);
    }

    function sell(address token, uint256 tokensIn, uint256 minEthOut) external nonReentrant {
        if (tokensIn == 0) revert ZeroAmount();
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();

        uint256 k = c.vEth * c.vToken;
        uint256 ethOut = c.vEth - k / (c.vToken + tokensIn);
        // Rounding can push ethOut a wei past what the curve actually holds.
        if (ethOut > c.realEth) ethOut = c.realEth;
        uint256 fee = (ethOut * feeBps) / FEE_DENOMINATOR;
        uint256 ethToSeller = ethOut - fee;
        if (ethToSeller < minEthOut) revert Slippage();

        c.vEth -= ethOut;
        c.vToken += tokensIn;
        c.realEth -= ethOut;
        c.sold -= tokensIn;

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        _splitFee(token, c.creator, c.quoteAsset, fee);
        _payOut(c.quoteAsset, msg.sender, ethToSeller);

        emit Sold(token, msg.sender, tokensIn, ethToSeller, fee);
    }

    // ---------------------------------------------------------------- views

    /// @notice Tokens received for `ethIn` (after fee), ignoring the final-buy cap.
    function quoteBuy(address token, uint256 ethIn) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        uint256 ethForCurve = ethIn - (ethIn * feeBps) / FEE_DENOMINATOR;
        uint256 k = c.vEth * c.vToken;
        uint256 out = c.vToken - k / (c.vEth + ethForCurve);
        uint256 remaining = CURVE_SUPPLY - c.sold;
        return out > remaining ? remaining : out;
    }

    /// @notice ETH received (after fee) for selling `tokensIn`.
    function quoteSell(address token, uint256 tokensIn) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        uint256 k = c.vEth * c.vToken;
        uint256 ethOut = c.vEth - k / (c.vToken + tokensIn);
        return ethOut - (ethOut * feeBps) / FEE_DENOMINATOR;
    }

    /// @notice Current spot price in wei per whole token (1e18 units).
    function currentPrice(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        return (c.vEth * 1e18) / c.vToken;
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    // ---------------------------------------------------------------- migrate

    /// @notice After graduation anyone can trigger the migration: the reserved
    ///         supply and the raised ETH are handed to the DEX adapter.
    function migrate(address token) external nonReentrant {
        _doMigrate(token);
    }

    function _doMigrate(address token) internal {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (!c.graduated) revert NotYetGraduated();
        if (address(migrator) == address(0)) revert MigratorNotSet();

        uint256 ethAmount = c.realEth;
        if (ethAmount == 0) revert ZeroAmount(); // already migrated
        c.realEth = 0;

        IERC20(token).safeTransfer(address(migrator), DEX_RESERVE);
        if (c.quoteAsset == address(0)) {
            migrator.migrate{value: ethAmount}(token, DEX_RESERVE, address(0), ethAmount);
        } else {
            IERC20(c.quoteAsset).safeTransfer(address(migrator), ethAmount);
            migrator.migrate(token, DEX_RESERVE, c.quoteAsset, ethAmount);
        }

        emit Migrated(token, DEX_RESERVE, ethAmount);
    }

    // ---------------------------------------------------------------- fees

    /// @notice Splits a trade fee: the creator+holders pot accrues either to
    ///         the creator or to holder cashback (the token's launch-time
    ///         choice), pull-withdrawal both ways; the remainder goes
    ///         straight to the treasury.
    function _splitFee(address token, address creator, address asset, uint256 fee) internal {
        uint256 pot = (fee * (creatorFeeShareBps + holderCashbackBps)) / FEE_DENOMINATOR;
        uint256 creatorCut;
        uint256 cashbackCut;
        if (feesToHolders[token]) {
            cashbackCut = pot;
            uint256 sold = curves[token].sold;
            if (cashbackCut > 0 && sold > 0) {
                accCashbackPerShare[token] += (cashbackCut * ACC_PRECISION) / sold;
            } else {
                // no holders yet: fold the cashback into the treasury share
                cashbackCut = 0;
            }
        } else if (pot > 0) {
            creatorCut = pot;
            address recipient = feeRecipient[token];
            if (recipient == address(0)) recipient = creator;
            creatorFees[recipient][asset] += creatorCut;
        }
        _payOut(asset, treasury, fee - creatorCut - cashbackCut);
    }

    /// @notice Transfer hook called by LaunchTokens right after every balance
    ///         change: harvests each wallet's accrual at its pre-transfer
    ///         balance and re-anchors its debt at the new balance, so cashback
    ///         stays pro-rata forever. Unknown callers only touch their own
    ///         isolated storage keys and can never mint claims (their
    ///         accumulator is always zero).
    function onTokenTransfer(address from, address to, uint256 value) external {
        address token = msg.sender;
        if (from != address(0) && from != address(this)) {
            uint256 newBal = IERC20(token).balanceOf(from);
            _settleCashback(token, from, newBal + value, newBal);
        }
        if (to != address(0) && to != address(this)) {
            uint256 newBal = IERC20(token).balanceOf(to);
            _settleCashback(token, to, newBal - value, newBal);
        }
    }

    function _settleCashback(address token, address holder, uint256 oldBal, uint256 newBal) internal {
        uint256 acc = accCashbackPerShare[token];
        uint256 debt = cashbackDebt[token][holder];
        uint256 earned = (oldBal * acc) / ACC_PRECISION;
        if (earned > debt) pendingCashback[token][holder] += earned - debt;
        cashbackDebt[token][holder] = (newBal * acc) / ACC_PRECISION;
    }

    /// @notice Live claimable cashback for a holder of `token`.
    function cashbackOf(address token, address holder) external view returns (uint256) {
        uint256 entitled = (IERC20(token).balanceOf(holder) * accCashbackPerShare[token]) / ACC_PRECISION;
        uint256 debt = cashbackDebt[token][holder];
        return pendingCashback[token][holder] + (entitled > debt ? entitled - debt : 0);
    }

    /// @notice Withdraw the trade-fee cashback earned by holding `token`.
    function claimCashback(address token) external nonReentrant {
        uint256 bal = IERC20(token).balanceOf(msg.sender);
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

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > 500) revert FeeTooHigh(); // max 5%
        feeBps = newFeeBps;
        emit FeeUpdated(newFeeBps);
    }

    function setFeeSplit(uint256 newCreatorBps, uint256 newCashbackBps) external onlyOwner {
        if (newCreatorBps + newCashbackBps > FEE_DENOMINATOR) revert FeeTooHigh();
        creatorFeeShareBps = newCreatorBps;
        holderCashbackBps = newCashbackBps;
        emit FeeSplitUpdated(newCreatorBps, newCashbackBps);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Enable (virtualReserve > 0) or disable (0) an ERC-20 quote
    ///         asset for new curves. The virtual reserve sizes the curve in
    ///         that asset's units (like 1.25 ETH does for native curves).
    function setQuoteAsset(address asset, uint256 virtualReserve) external onlyOwner {
        quoteVirtualReserve[asset] = virtualReserve;
        emit QuoteAssetUpdated(asset, virtualReserve);
    }

    function setMigrator(address newMigrator) external onlyOwner {
        migrator = IDexMigrator(newMigrator);
        emit MigratorUpdated(newMigrator);
    }

    function _payOut(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (asset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
