// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchTokenFactory} from "./LaunchTokenFactory.sol";
import {IDexMigrator, IDexMigratorUnlock, IDexMigratorBuyback} from "./interfaces/IDexMigrator.sol";

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
    /// The platform fee on every curve trade, buys and sells alike.
    uint256 public feeBps = 100; // 1%
    /// Of the platform fee, creatorFeeShareBps + holderCashbackBps form the
    /// coin's pot; the remainder goes to the treasury. The pot — and the
    /// coin's own tax on top of the platform fee, whole — is split as the
    /// creator set at launch (FeeConfig): creator, holders as cashback,
    /// buyback-and-burn, liquidity. Creator fees and cashback are pull-based
    /// (claim functions), so no external address can ever block trades.
    uint256 public creatorFeeShareBps = 5_000;
    uint256 public holderCashbackBps = 3_000;
    /// The most a coin's own tax can be, on either side.
    uint256 public constant MAX_TAX_BPS = 1_000; // 10%
    address public treasury;
    IDexMigrator public migrator;
    /// Deploys the coins' tokens: their creation code lives there, not here.
    LaunchTokenFactory public immutable tokenFactory;

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
    /// Holder fees are only spread over at least one whole token; below that
    /// the pot joins the treasury share. A near-empty denominator would blow
    /// the accumulator up until balance * acc overflows and every transfer of
    /// the token reverts.
    uint256 private constant MIN_ELIGIBLE_SUPPLY = 1e18;
    mapping(address token => uint256) public accCashbackPerShare;
    mapping(address token => mapping(address holder => uint256)) public pendingCashback;
    mapping(address token => mapping(address holder => uint256)) public cashbackDebt;

    /// Tokens held by cashback-eligible wallets, per token — everyone except
    /// the zero address, this contract (unsold curve inventory) and the
    /// Uniswap v4 PoolManager (graduated pool reserves). Holder fees are
    /// spread over exactly this supply, which keeps the accumulator solvent
    /// after graduation, when part of the supply sits inside the pool.
    mapping(address token => uint256) public eligibleSupply;

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

    /// A coin as a frozen launchpad elsewhere recorded it, for migrateToken:
    /// the Notus ledger on Litecoin, or a Launchpad on another chain (see
    /// MIGRATION.md). Amounts arrive in wei and 1e18-unit tokens; a source
    /// with fewer decimals is scaled by the snapshot tool.
    struct LedgerCoin {
        string name;
        string symbol;
        TokenMetadata meta;
        address creator;
        FeeConfig fees;
        uint256 virtualQuote; //  the ledger's virtual quote reserve
        uint256 sold; //          tokens that left its curve: what holders own (delivered by migrateToken/migrateBalances) plus `burned`
        uint256 burned; //        bought back and burned there: burned here too at birth
        uint256 poolToken; //     a coin that graduated there: the token side of its locked pool (0 = still on the curve)
        uint256 burnPot; //       its pots, unspent there, part of msg.value alongside the reserve
        uint256 liquidityPot;
    }

    mapping(address token => Curve) public curves;
    mapping(address token => TokenMetadata) public tokenMetadata;
    /// Coins migrated from a ledger: tokens still to be handed to their
    /// holders. Trading waits for zero.
    mapping(address token => uint256) public migrationPending;
    /// How many migrated coins still have holders to deliver: a freeze is
    /// not announced over one (its deliveries could never finish), and none
    /// arrives once a freeze is announced.
    uint256 public pendingCoins;
    /// Coins that graduated on the ledger: the token side of the locked pool
    /// they arrived with, handed to the DEX in place of DEX_RESERVE.
    mapping(address token => uint256) public migratedPoolTokens;
    /// Coins of a graduated coin's DEX reserve that never reach its pool and
    /// stay here for good: the curve's virtual share of the supply, so that
    /// the pool opens at the price the curve closed at (see _doMigrate). For
    /// a coin that arrived graduated from a ledger, what its holders and its
    /// pool leave of the supply.
    mapping(address token => uint256) public lockedAtGraduation;
    /// The ledger snapshot every migrated coin comes from: its state root,
    /// the block it froze at and which chain, set once before the first coin
    /// and never changed, so anyone can replay the ledger to that root and
    /// compare. Closing ends the migration for good.
    bytes32 public migrationRoot;
    uint256 public migrationFreezeHeight;
    bool public migrationClosed;
    /// One token per ledger ticker: a coin cannot be migrated twice.
    mapping(bytes32 symbolHash => address) public migratedTicker;
    /// Each holder of a migrated coin is delivered once: a batch sent twice
    /// reverts instead of paying twice and starving the holders after it.
    mapping(address token => mapping(address holder => bool)) public migrationDelivered;

    // ------------------------------------------- migration to another chain
    /// The block from which this launchpad stands still so that its coins can
    /// be re-created on another chain (Base → LitVM) with the same holders and
    /// the same price: from it on, no creation, buy, sell or token transfer.
    /// 0 = none announced. Announced by the owner — a timelock, so the block
    /// is public for the timelock's delay before it can even be set.
    uint256 public freezeBlock;
    /// Coins whose reserve left for the other chain (migrateOut).
    mapping(address token => bool) public migratedOut;
    /// The migrator that seeded each graduated coin's pool: the one that can
    /// unlock it again for a migration.
    mapping(address token => IDexMigrator) public graduatedVia;
    /// The coin whose pool is being unlocked right now: its tokens may move
    /// while everything else is frozen.
    address public unlocking;
    /// The pool a migrated coin left behind (its migrator's pair): transfers
    /// out of it stay free after migrateOut, so the liquidity somebody else
    /// added there can be withdrawn — nothing can be sold into it or added.
    mapping(address token => address) public migratedPair;
    /// Per-token override for where the creator share of fees accrues.
    /// address(0) = the token's creator.
    mapping(address token => address) public feeRecipient;
    /// Launch-time fee destination, immutable so buyers can rely on it:
    /// true = the whole creator+holders pot is holder cashback, false = it
    /// all accrues to the creator.
    /// How a coin taxes and splits its fees, fixed at launch: its own tax on
    /// buys and on sells (basis points of the trade, at most MAX_TAX_BPS),
    /// and the shares of its pot — the platform fee's pot plus the whole tax
    /// — that go to the creator, to holders as cashback, to buying the coin
    /// back and burning it, and to its pool's liquidity (basis points, 10,000
    /// in all).
    struct FeeConfig {
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 creatorBps;
        uint16 holdersBps;
        uint16 burnBps;
        uint16 liquidityBps;
    }

    mapping(address token => FeeConfig) public feeConfig;
    /// Quote set aside to buy the coin back and burn it (buybackAndBurn).
    mapping(address token => uint256) public burnPot;
    /// Quote set aside for the coin's pool, joining its quote side at graduation.
    mapping(address token => uint256) public liquidityPot;
    /// Coins bought back and burned so far: they left the curve (part of
    /// `sold`) and exist no more, so holders own `sold` less this.
    mapping(address token => uint256) public burned;
    /// The first block a coin's next buyback may happen in: one a block, a slice at a time.
    mapping(address token => uint256) public nextBurnBlock;
    address[] public allTokens;

    // ---------------------------------------------------------------- events

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, bool feesToHolders);
    event FeesConfigured(
        address indexed token,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        uint16 creatorBps,
        uint16 holdersBps,
        uint16 burnBps,
        uint16 liquidityBps
    );
    /// The burn pot bought the coin back — on the curve or on the pool — and burned it.
    event BoughtBack(address indexed token, uint256 quoteIn, uint256 tokensBurned);
    /// The coin's metadata changed: read tokenMetadata(token).
    event MetadataUpdated(address indexed token);
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
    event TokenMigrated(
        address indexed token, address indexed creator, uint256 virtualQuote, uint256 realQuote, uint256 sold
    );
    event MigrationBalances(address indexed token, uint256 holders, uint256 pending);
    event MigrationRootSet(bytes32 root, uint256 freezeHeight);
    event MigrationClosed();
    event FreezeAnnounced(uint256 freezeBlock);
    event FreezeCancelled();
    event MigratedOut(address indexed token, address indexed to, uint256 quoteAmount, uint256 tokensBurned);

    // ---------------------------------------------------------------- errors

    error UnknownToken();
    error NotCreator();
    error AlreadyGraduated();
    error NotYetGraduated();
    error ZeroAmount();
    error Slippage();
    error FeeTooHigh();
    /// a tax above MAX_TAX_BPS, or shares that do not add up to 10,000.
    error BadFeeConfig();
    /// one buyback a block per coin.
    error BurnCooldown();
    error MigratorNotSet();
    error EthTransferFailed();
    error QuoteAssetNotEnabled();
    error WrongPayment();
    error MigrationPending();
    error BadMigration();
    /// migrateToken outside an open migration (no root set, or closed).
    error MigrationNotOpen();
    /// a ledger ticker that already has its token here.
    error TickerMigrated();
    /// a holder of a migrated coin listed a second time.
    error AlreadyDelivered(address holder);
    /// a curve coin's reserve does not match its curve state.
    error WrongQuote();
    /// the launchpad stands still for a migration (see freezeBlock).
    error Frozen();
    /// a freeze is announced: no new coin here until the coins have moved.
    error CreationClosed();
    /// migrateOut before the freeze block.
    error NotFrozen();
    /// a freeze is already announced (cancel it first) or would be in the past.
    error BadFreeze();
    /// a coin's reserve already left.
    error AlreadyMigratedOut();

    constructor(address treasury_) Ownable(msg.sender) {
        treasury = treasury_;
        tokenFactory = new LaunchTokenFactory();
        // the native coin is a quote asset like any other, on from the start;
        // a pad quoted in an ERC-20 alone switches it off (setQuoteAsset(0, 0))
        quoteVirtualReserve[address(0)] = VIRTUAL_ETH;
        emit QuoteAssetUpdated(address(0), VIRTUAL_ETH);
    }

    // ---------------------------------------------------------------- create

    /// @notice Deploy a new token and open its curve. Sending ETH performs an
    ///         initial buy for the creator in the same transaction. No tax of
    ///         its own; `feesToHolders_` sends the whole pot to holders as
    ///         cashback (true) or to the creator (false), forever.
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
    ///         each, and how its pot is split, fixed forever. Sending ETH
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
        token = _create(name, symbol, meta, quoteAsset, fees, false);

        if (quoteAsset == address(0)) {
            if (msg.value > 0) _buy(token, msg.sender, msg.value, minTokensOut);
        } else if (msg.value > 0) {
            revert WrongPayment();
        }
    }

    /// The launch-time choice before taxes: the whole pot to holders, or to the creator.
    function _defaultFees(bool toHolders) internal pure returns (FeeConfig memory) {
        return FeeConfig(0, 0, toHolders ? 0 : 10_000, toHolders ? 10_000 : 0, 0, 0);
    }

    /// Validate and record a coin's fee configuration.
    function _setFees(address token, FeeConfig memory fees) internal {
        if (
            fees.buyTaxBps > MAX_TAX_BPS || fees.sellTaxBps > MAX_TAX_BPS
                || uint256(fees.creatorBps) + fees.holdersBps + fees.burnBps + fees.liquidityBps != FEE_DENOMINATOR
        ) revert BadFeeConfig();
        feeConfig[token] = fees;
        emit FeesConfigured(
            token, fees.buyTaxBps, fees.sellTaxBps, fees.creatorBps, fees.holdersBps, fees.burnBps, fees.liquidityBps
        );
    }

    /// @notice Whether holders earn cashback on this coin (a holders share above zero).
    function feesToHolders(address token) external view returns (bool) {
        return feeConfig[token].holdersBps != 0;
    }

    /// @notice Deploy a Notus Pre-Market (owner only): a synthetic pre-IPO
    ///         asset on its own ETH curve, transferable from day one, fees in
    ///         holders-rewards mode, and immediately whitelisted as a quote
    ///         asset so new tokens can pair with it (`quoteVirtualReserve_`
    ///         sizes those paired curves in pre-market units — retune later
    ///         with setQuoteAsset as its price discovers).
    function createPreMarket(
        string calldata name,
        string calldata symbol,
        TokenMetadata calldata meta,
        uint256 quoteVirtualReserve_
    ) external onlyOwner nonReentrant returns (address token) {
        token = _create(name, symbol, meta, address(0), _defaultFees(true), true);
        quoteVirtualReserve[token] = quoteVirtualReserve_;
        emit QuoteAssetUpdated(token, quoteVirtualReserve_);
    }

    function _create(
        string calldata name,
        string calldata symbol,
        TokenMetadata calldata meta,
        address quoteAsset,
        FeeConfig memory fees,
        bool transferable_
    ) internal returns (address token) {
        // announced or landed, a freeze closes the pad to new coins: the list
        // of coins that move to the other chain is final from the announcement
        if (freezeBlock != 0) revert CreationClosed();
        uint256 vQuote = quoteVirtualReserve[quoteAsset];
        if (vQuote == 0) revert QuoteAssetNotEnabled();
        token = tokenFactory.create(name, symbol, TOTAL_SUPPLY, transferable_);
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

        uint256 f = feeBps + feeConfig[token].buyTaxBps; // the platform fee and the coin's own tax
        uint256 fee = (ethIn * f) / FEE_DENOMINATOR;
        uint256 ethForCurve = ethIn - fee;

        uint256 tokensOut = c.vToken - (c.vEth * c.vToken) / (c.vEth + ethForCurve);

        // Cap the final buy to what's left on the curve and refund the surplus.
        uint256 remaining = CURVE_SUPPLY - c.sold;
        uint256 refund = 0;
        if (tokensOut >= remaining) {
            tokensOut = remaining;
            // ETH needed to buy exactly `remaining`: x' = k / (y - out) - x
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

    /// @notice The curve sold out: close it and hand the reserve to the DEX,
    ///         in the same transaction and as one piece. A failing DEX leg
    ///         fails the trade that crossed the line; the earlier design
    ///         caught it (`try/catch`) so the graduation would stand anyway,
    ///         and that left a window — the token transferable, the reserve
    ///         still here, `migrate` public — in which whoever starved that
    ///         call of gas could set the pool's price before the reserve
    ///         reached it. Now a coin is never graduated with its reserve
    ///         waiting, unless no migrator is set at all.
    function _graduate(address token, Curve storage c) internal {
        c.graduated = true;
        LaunchToken(token).setGraduated();
        emit Graduated(token, c.realEth);
        if (address(migrator) != address(0)) _doMigrate(token);
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
        uint256 f = feeBps + feeConfig[token].sellTaxBps;
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
    ///         supply and the raised ETH are handed to the DEX adapter.
    function migrate(address token) external nonReentrant {
        _doMigrate(token);
    }

    function _doMigrate(address token) internal {
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (!c.graduated) revert NotYetGraduated();
        if (address(migrator) == address(0)) revert MigratorNotSet();
        if (frozen()) revert Frozen();

        uint256 ethAmount = c.realEth;
        if (ethAmount == 0) revert ZeroAmount(); // already migrated
        c.realEth = 0;
        graduatedVia[token] = migrator;
        // the coin's liquidity pot joins the pool's quote side: that much deeper (and higher) an opening
        ethAmount += liquidityPot[token];
        liquidityPot[token] = 0;

        // a coin that graduated on a ledger brings its own pool's token side;
        // one that graduated here opens its pool at the price the curve closed
        // at: the quote that goes in (the raise and the liquidity pot) against
        // as many coins as that price says, never more than the DEX reserve.
        // The rest of the reserve — the curve's virtual share of the supply,
        // 9.52M of the 200M by the constants — stays here for good; put in the
        // pool as well, it would open the pool 4.8% under the closing price
        uint256 reserve = migratedPoolTokens[token];
        if (reserve == 0) {
            reserve = Math.mulDiv(ethAmount, c.vToken, c.vEth);
            if (reserve > DEX_RESERVE) reserve = DEX_RESERVE;
            lockedAtGraduation[token] = DEX_RESERVE - reserve;
        }

        IERC20(token).safeTransfer(address(migrator), reserve);
        if (c.quoteAsset == address(0)) {
            migrator.migrate{value: ethAmount}(token, reserve, address(0), ethAmount);
        } else {
            IERC20(c.quoteAsset).safeTransfer(address(migrator), ethAmount);
            migrator.migrate(token, reserve, c.quoteAsset, ethAmount);
        }

        emit Migrated(token, reserve, ethAmount);
    }

    // ------------------------------------------------- migration from a ledger

    /// @notice Owner only, once per coin: re-create a coin that lived on a
    ///         contract-less Notus ledger exactly as the frozen ledger
    ///         recorded it, so trading continues here at the same price.
    ///         msg.value is the quote actually in its curve (the LTC bridged
    ///         over); `holders`/`balances` deliver what the ledger sold, here
    ///         and, for large holder sets, in further migrateBalances calls.
    ///         Buys and sells open once every token is delivered. Cashback
    ///         and creator fees accrued on the ledger are paid out there.
    ///         A coin that graduated on the ledger comes with its locked pool
    ///         (`poolToken` tokens against msg.value): it graduates here as
    ///         soon as its holders are served and that pool goes to the DEX.
    function migrateToken(LedgerCoin calldata coin, address[] calldata holders, uint256[] calldata balances)
        external
        payable
        onlyOwner
        nonReentrant
        returns (address token)
    {
        if (freezeBlock != 0) revert CreationClosed();
        _checkLedgerCoin(coin, holders.length);
        token = tokenFactory.create(coin.name, coin.symbol, TOTAL_SUPPLY, false);
        _claimTicker(coin.symbol, token);
        curves[token] = _ledgerCurve(coin);
        tokenMetadata[token] = coin.meta;
        _setFees(token, coin.fees);
        if (coin.burned != 0) {
            burned[token] = coin.burned;
            LaunchToken(token).burn(coin.burned);
        }
        burnPot[token] = coin.burnPot;
        liquidityPot[token] = coin.liquidityPot;
        if (coin.poolToken != 0) {
            migratedPoolTokens[token] = coin.poolToken;
            lockedAtGraduation[token] = TOTAL_SUPPLY - coin.sold - coin.poolToken; // what stays here, as on the ledger
        }
        allTokens.push(token);
        migrationPending[token] = coin.sold - coin.burned; // what its holders own, to deliver
        if (coin.sold != coin.burned) pendingCoins++;
        emit TokenCreated(token, coin.creator, coin.name, coin.symbol, coin.fees.holdersBps != 0);
        emit MetadataUpdated(token);
        emit TokenMigrated(token, coin.creator, coin.virtualQuote, _ledgerReserve(coin), coin.sold);
        if (coin.sold != coin.burned) _migrateBalances(token, holders, balances);
        // a pooled coin nobody holds any more (all sold into its pool, or burned) has no delivery to wait for
        else if (coin.poolToken != 0) _graduate(token, curves[token]);
    }

    /// An open migration, and one token per ledger ticker.
    function _claimTicker(string calldata symbol, address token) internal {
        if (migrationRoot == bytes32(0) || migrationClosed) revert MigrationNotOpen();
        bytes32 sym = keccak256(bytes(symbol));
        if (migratedTicker[sym] != address(0)) revert TickerMigrated();
        migratedTicker[sym] = token;
    }

    /// Only state the ledger could have produced. A coin that graduated there
    /// (poolToken != 0) has `sold` = everything its holders own and `poolToken`
    /// = what its pool holds, the two adding up to at most the supply (what
    /// they leave stayed locked where it graduated, and stays locked here),
    /// and its pool always has a quote side.
    function _checkLedgerCoin(LedgerCoin calldata coin, uint256 holderCount) internal view {
        if (coin.creator == address(0) || coin.virtualQuote == 0 || coin.burned > coin.sold) revert BadMigration();
        uint256 reserve = _ledgerReserve(coin); // msg.value less the pots
        if (coin.poolToken != 0) {
            if (coin.sold + coin.poolToken > TOTAL_SUPPLY || reserve == 0) revert BadMigration();
        } else if (coin.sold > CURVE_SUPPLY) {
            revert BadMigration();
        } else if (coin.sold != 0) {
            // a constant-product curve holds exactly virtual * sold / (VIRTUAL_TOKEN - sold)
            // of real quote (the ledger rounds each trade by at most one unit): the
            // coin must arrive with that much, no less (sells could not be paid) and
            // no more (the price would be wrong)
            uint256 expected = Math.mulDiv(coin.virtualQuote, coin.sold, VIRTUAL_TOKEN - coin.sold);
            uint256 tolerance = expected / 200 + 1e12; // 0.5% plus dust
            if (reserve + tolerance < expected || reserve > expected + tolerance) revert WrongQuote();
        }
        if (coin.sold == 0 && (reserve != 0 || holderCount != 0)) revert BadMigration(); // an untraded coin
    }

    /// The reserve a ledger coin arrives with: msg.value less its pots.
    function _ledgerReserve(LedgerCoin calldata coin) internal view returns (uint256) {
        uint256 pots = coin.burnPot + coin.liquidityPot;
        if (msg.value < pots) revert BadMigration();
        return msg.value - pots;
    }

    /// The curve as the ledger left it. A pooled coin's curve is complete:
    /// it graduates once its holders are served (see _migrateBalances).
    function _ledgerCurve(LedgerCoin calldata coin) internal view returns (Curve memory) {
        bool pooled = coin.poolToken != 0;
        uint256 reserve = _ledgerReserve(coin);
        return Curve({
            vEth: coin.virtualQuote + reserve,
            vToken: pooled ? VIRTUAL_TOKEN - CURVE_SUPPLY : VIRTUAL_TOKEN - coin.sold,
            realEth: reserve,
            sold: pooled ? CURVE_SUPPLY : coin.sold,
            graduated: false,
            creator: coin.creator,
            quoteAsset: address(0)
        });
    }

    /// @notice Deliver more of a migrated coin's balances (owner only).
    function migrateBalances(address token, address[] calldata holders, uint256[] calldata balances)
        external
        onlyOwner
        nonReentrant
    {
        if (frozen()) revert Frozen();
        if (curves[token].vEth == 0) revert UnknownToken();
        _migrateBalances(token, holders, balances);
    }

    function _migrateBalances(address token, address[] calldata holders, uint256[] calldata balances) internal {
        if (holders.length != balances.length) revert BadMigration();
        uint256 pending = migrationPending[token];
        if (pending == 0) revert BadMigration(); // not migrating (any more)
        for (uint256 i = 0; i < holders.length; i++) {
            if (migrationDelivered[token][holders[i]]) revert AlreadyDelivered(holders[i]);
            migrationDelivered[token][holders[i]] = true;
            if (balances[i] > pending) revert BadMigration(); // more than the ledger sold
            pending -= balances[i];
            IERC20(token).safeTransfer(holders[i], balances[i]);
        }
        migrationPending[token] = pending;
        emit MigrationBalances(token, holders.length, pending);
        if (pending == 0) {
            pendingCoins--;
            // a coin whose curve had sold out on the ledger graduates as soon as
            // its holders have their tokens
            if (curves[token].sold == CURVE_SUPPLY) _graduate(token, curves[token]);
        }
    }

    // ---------------------------------------------------------------- fees

    /// @notice Splits a curve trade fee (see _accrueFee); the treasury share
    ///         is paid straight out.
    function _splitFee(address token, address creator, address asset, uint256 fee, uint256 f) internal {
        _payOut(asset, treasury, _accrueFee(token, creator, asset, fee, f));
    }

    /// @notice Accrues a fee taken at the rate `f` (the platform fee and the
    ///         coin's tax together): the treasury's share of the platform
    ///         fee's part comes off first, the rest is the coin's pot, split
    ///         as its FeeConfig says — to the creator (pull-withdrawal), to
    ///         holders as cashback (pull-withdrawal; to the treasury while
    ///         there is no eligible supply), to the burn pot, and to the
    ///         liquidity pot. Fees accrue on the curve alone: once the coin
    ///         graduates its pool's fees are the pool's. Returns the
    ///         treasury share, rounding dust included.
    function _accrueFee(address token, address creator, address asset, uint256 fee, uint256 f)
        internal
        returns (uint256 toTreasury)
    {
        if (fee == 0) return 0;
        uint256 pot = (fee * feeBps) / f; // the platform fee's part of it...
        pot = fee - (pot - (pot * (creatorFeeShareBps + holderCashbackBps)) / FEE_DENOMINATOR); // ...less the treasury's share
        toTreasury = fee - pot + _splitPot(token, creator, asset, pot);
    }

    /// Splits a coin's pot as its FeeConfig says; returns what falls to the
    /// treasury: rounding dust, and the holders' share while there is no
    /// eligible supply.
    function _splitPot(address token, address creator, address asset, uint256 pot)
        internal
        returns (uint256 toTreasury)
    {
        FeeConfig storage cfg = feeConfig[token];
        uint256 toCreator = (pot * cfg.creatorBps) / FEE_DENOMINATOR;
        uint256 toHolders = (pot * cfg.holdersBps) / FEE_DENOMINATOR;
        uint256 toBurn = (pot * cfg.burnBps) / FEE_DENOMINATOR;
        uint256 toLiquidity = (pot * cfg.liquidityBps) / FEE_DENOMINATOR;
        toTreasury = pot - toCreator - toHolders - toBurn - toLiquidity; // rounding dust
        if (toCreator != 0) {
            address recipient = feeRecipient[token];
            if (recipient == address(0)) recipient = creator;
            creatorFees[recipient][asset] += toCreator;
        }
        if (toHolders != 0) {
            uint256 eligible = eligibleSupply[token];
            if (eligible < MIN_ELIGIBLE_SUPPLY) toTreasury += toHolders;
            else accCashbackPerShare[token] += (toHolders * ACC_PRECISION) / eligible;
        }
        if (toLiquidity != 0) liquidityPot[token] += toLiquidity;
        if (toBurn != 0) burnPot[token] += toBurn;
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

    /// @notice Transfer hook called by LaunchTokens right after every balance
    ///         change: harvests each wallet's accrual at its pre-transfer
    ///         balance, re-anchors its debt at the new balance and keeps the
    ///         eligible supply in sync, so cashback stays pro-rata forever.
    ///         Unknown callers only touch their own isolated storage keys and
    ///         can never mint claims (their accumulator is always zero).
    function onTokenTransfer(address from, address to, uint256 value) external {
        address token = msg.sender;
        bool fromEligible = _isEligible(from);
        bool toEligible = _isEligible(to);

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

    function _isEligible(address account) internal view returns (bool) {
        return account != address(0) && account != address(this);
    }

    /// Entitlements round down and debts round up: with both floored, every
    /// settle could overpay a wallet by a wei, and the dust adds up past what
    /// the contract holds.
    function _settleCashback(address token, address holder, uint256 oldBal, uint256 newBal) internal {
        uint256 acc = accCashbackPerShare[token];
        uint256 debt = cashbackDebt[token][holder];
        uint256 earned = Math.mulDiv(oldBal, acc, ACC_PRECISION);
        if (earned > debt) pendingCashback[token][holder] += earned - debt;
        cashbackDebt[token][holder] = Math.mulDiv(newBal, acc, ACC_PRECISION, Math.Rounding.Ceil);
    }

    /// @notice Live claimable cashback for a holder of `token`.
    function cashbackOf(address token, address holder) external view returns (uint256) {
        uint256 entitled = Math.mulDiv(IERC20(token).balanceOf(holder), accCashbackPerShare[token], ACC_PRECISION);
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

    /// @notice Enable/disable many quote assets at once — the whole RWA
    ///         catalogue (stocks, ETFs, commodities) fits in one transaction.
    function setQuoteAssets(address[] calldata assets, uint256[] calldata virtualReserves) external onlyOwner {
        if (assets.length != virtualReserves.length) revert ZeroAmount();
        for (uint256 i = 0; i < assets.length; i++) {
            quoteVirtualReserve[assets[i]] = virtualReserves[i];
            emit QuoteAssetUpdated(assets[i], virtualReserves[i]);
        }
    }

    function setMigrator(address newMigrator) external onlyOwner {
        migrator = IDexMigrator(newMigrator);
        emit MigratorUpdated(newMigrator);
    }

    /// @notice Open the migration from a frozen ledger: its state root and
    ///         the block it froze at, once and for all (the ledger's network
    ///         is the one this chain pairs with). Every migrateToken call
    ///         must follow this, and anyone can replay the ledger to this
    ///         root to check what was migrated.
    function setMigrationRoot(bytes32 root, uint256 freezeHeight) external onlyOwner {
        if (root == bytes32(0) || migrationRoot != bytes32(0)) revert BadMigration();
        migrationRoot = root;
        migrationFreezeHeight = freezeHeight;
        emit MigrationRootSet(root, freezeHeight);
    }

    /// @notice End the migration: no coin can be migrated after this, ever.
    ///         Balances still pending for coins already migrated can still be delivered.
    function closeMigration() external onlyOwner {
        migrationClosed = true;
        emit MigrationClosed();
    }

    // ------------------------------------------- migration to another chain

    /// @notice Whether this launchpad stands still: the freeze block was
    ///         announced and is reached.
    function frozen() public view returns (bool) {
        return freezeBlock != 0 && block.number >= freezeBlock;
    }

    /// @notice Whether a transfer of `token` from `from` is frozen right now.
    ///         Once the freeze lands everything is, except: the pad's own
    ///         transfers (each of its paths is frozen on its own, so what it
    ///         still moves — fee claims, a reserve leaving, the burn — is
    ///         meant to); the coin whose pool is being unlocked, and that
    ///         pool's quote when it is a coin of this pad (a pre-market); and,
    ///         after migrateOut, transfers out of the pool the coin left, so
    ///         its other liquidity providers can withdraw. The LaunchToken
    ///         asks on every transfer.
    function frozenFor(address token, address from) external view returns (bool) {
        if (!frozen() || from == address(this)) return false;
        address u = unlocking;
        if (u != address(0) && (token == u || token == curves[u].quoteAsset)) return false;
        return !(migratedOut[token] && from == migratedPair[token]);
    }

    /// @notice Announce the block from which the launchpad stands still, so
    ///         its coins can be re-created on another chain: the block must
    ///         not be past, only one freeze can be announced at a time, and
    ///         not over a migrated coin still delivering its holders. From
    ///         the announcement on no new coin is created here. The
    ///         owner is a timelock, so the announcement is public for the
    ///         delay before it can be made; and since cancelFreeze takes the
    ///         same delay, a freeze can only be called off if its block lies
    ///         more than one delay past the announcement.
    function announceFreeze(uint256 atBlock) external onlyOwner {
        if (freezeBlock != 0 || atBlock < block.number) revert BadFreeze();
        if (pendingCoins != 0) revert MigrationPending();
        freezeBlock = atBlock;
        emit FreezeAnnounced(atBlock);
    }

    /// @notice Withdraw an announced freeze before it lands (the other chain
    ///         is late); after it lands there is no way back.
    function cancelFreeze() external onlyOwner {
        if (freezeBlock == 0 || block.number >= freezeBlock) revert BadFreeze();
        freezeBlock = 0;
        emit FreezeCancelled();
    }

    /// @notice Once frozen, take a coin's quote out to bridge it to the chain
    ///         where the coin is re-created: a curve coin's reserve as it
    ///         stands; a graduated coin's pool, unlocked by the migrator that
    ///         seeded it — its quote side leaves, its token side comes back
    ///         here and is burned, so the supply mirrors what holders own,
    ///         and the pool stays open to withdrawals (migratedPair). The
    ///         migrator must be able to give the pool back (IDexMigratorUnlock):
    ///         one that cannot makes this revert, and the coin stays.
    ///         Cashback and creator fees accrued here stay claimable here,
    ///         whatever their quote. Once per coin; this is the operator's
    ///         custody of the reserve, announced through the timelock like
    ///         the freeze itself.
    function migrateOut(address token, address to)
        external
        onlyOwner
        nonReentrant
        returns (uint256 quoteOut, uint256 tokensBurned)
    {
        if (!frozen()) revert NotFrozen();
        if (to == address(0)) revert ZeroAmount();
        Curve storage c = curves[token];
        if (c.vEth == 0) revert UnknownToken();
        if (migratedOut[token]) revert AlreadyMigratedOut();
        migratedOut[token] = true;
        // its pots, unspent, go with it
        uint256 pots = burnPot[token] + liquidityPot[token];
        burnPot[token] = 0;
        liquidityPot[token] = 0;

        IDexMigrator via = graduatedVia[token];
        if (!c.graduated || address(via) == address(0)) {
            // on its curve — or graduated with its reserve still parked here
            quoteOut = c.realEth + pots;
            c.realEth = 0;
            _payOut(c.quoteAsset, to, quoteOut);
        } else {
            unlocking = token;
            address pool;
            (quoteOut, tokensBurned, pool) = IDexMigratorUnlock(address(via)).unlock(token, to);
            if (tokensBurned > 0) LaunchToken(token).burn(tokensBurned);
            unlocking = address(0);
            migratedPair[token] = pool;
            _payOut(c.quoteAsset, to, pots);
            quoteOut += pots;
        }
        emit MigratedOut(token, to, quoteOut, tokensBurned);
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
