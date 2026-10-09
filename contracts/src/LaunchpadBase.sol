// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "openzeppelin-contracts/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchTokenFactory} from "./LaunchTokenFactory.sol";
import {IDexMigrator} from "./interfaces/IDexMigrator.sol";

/// @title LaunchpadBase
/// @notice Everything the Launchpad and its migration module share: the
///         storage, in one order for both (the module runs by delegatecall in
///         the launchpad's storage), the structs, the events, the errors and
///         the internals both need. The launchpad's runtime is bounded by
///         EIP-170; the split keeps the live surface in one contract and the
///         migration (from a ledger, to another chain) in another.
abstract contract LaunchpadBase is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- config

    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18; // 1B per token
    uint256 public constant CURVE_SUPPLY = 800_000_000e18; //   800M sold on curve
    uint256 public constant DEX_RESERVE = TOTAL_SUPPLY - CURVE_SUPPLY; // 200M for DEX

    /// virtual reserves at curve start; they set the initial price and the
    /// total quote the curve raises (~ VIRTUAL_ETH * CURVE_SUPPLY / VIRTUAL_TOKEN
    /// at completion). With 1.25 ETH / 1.05B tokens the curve raises ~4 ETH.
    uint256 public constant VIRTUAL_ETH = 1.25 ether;
    uint256 public constant VIRTUAL_TOKEN = 1_050_000_000e18;

    uint256 public constant FEE_DENOMINATOR = 10_000;
    /// The most a coin's own tax can be, on either side.
    uint256 public constant MAX_TAX_BPS = 1_000; // 10%
    /// The most the launchpad's fee can be set to.
    uint256 public constant MAX_FEE_BPS = 500; // 5%

    // ---------------------------------------------------------------- state

    /// The launchpad's fee on every trade, buys and sells alike, on the curve
    /// and on the pool: whole to the treasury. A coin keeps the rate it
    /// launched with (FeeConfig.platformBps): a change applies to coins
    /// created afterwards.
    uint256 public feeBps = 50; // 0.5%
    address public treasury;
    IDexMigrator public migrator;
    /// Deploys the coins' tokens: their creation code lives there, not here.
    /// Storage, not immutable: the migration module runs this contract's code
    /// by delegatecall, and an immutable would be the module's own value (its
    /// own factory, which answers to it, not to the launchpad) instead of the
    /// launchpad's. The Launchpad's constructor sets it, once.
    LaunchTokenFactory public tokenFactory;

    /// Creator fee accruals per recipient per asset (address(0) = ETH).
    mapping(address recipient => mapping(address asset => uint256)) public creatorFees;

    /// Quote assets enabled for new curves: virtual reserve per asset
    /// (position-sizes the curve in that asset's units/decimals). 0 = disabled.
    mapping(address asset => uint256) public quoteVirtualReserve;

    /// Holder cashback: a per-token rewards accumulator (1e30 precision — high
    /// enough that low-decimal quote assets never round the per-share
    /// increment to zero against 1e18-decimal token supplies). Every balance
    /// change settles the affected wallets via the token's transfer hook, so
    /// pro-rata accounting stays exact even after graduation when transfers
    /// are free.
    uint256 internal constant ACC_PRECISION = 1e30;
    /// Holder fees are only spread over at least one whole token; below that
    /// the pot joins the treasury share. A near-empty denominator would blow
    /// the accumulator up until balance * acc overflows and every transfer of
    /// the token reverts.
    uint256 internal constant MIN_ELIGIBLE_SUPPLY = 1e18;
    mapping(address token => uint256) public accCashbackPerShare;
    mapping(address token => mapping(address holder => uint256)) public pendingCashback;
    mapping(address token => mapping(address holder => uint256)) public cashbackDebt;

    /// Tokens held by cashback-eligible wallets, per token — everyone except
    /// the zero address, this contract (unsold curve inventory, the lock, the
    /// tax), the coin's pools (registered: taxedPool) and the migrator that
    /// seeded its pool. Holder fees are spread over exactly this supply, which
    /// keeps the accumulator solvent after graduation, when part of the supply
    /// sits inside the pool.
    mapping(address token => uint256) public eligibleSupply;

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

    /// How a coin taxes and splits its fees, fixed at launch: its own tax on
    /// buys and on sells (basis points of the trade, at most MAX_TAX_BPS),
    /// the shares of that tax that go to the creator, to holders as cashback,
    /// to buying the coin back and burning it, and to its pool's liquidity
    /// (basis points, 10,000 in all), and the launchpad's own fee as it stood
    /// when the coin was created (platformBps: whole to the treasury, never
    /// part of the shares).
    struct FeeConfig {
        uint16 buyTaxBps;
        uint16 sellTaxBps;
        uint16 creatorBps;
        uint16 holdersBps;
        uint16 burnBps;
        uint16 liquidityBps;
        uint16 platformBps;
    }

    /// A coin as a frozen launchpad elsewhere recorded it, for migrateToken:
    /// the Notus ledger on Litecoin, or a Launchpad on another chain, or this
    /// chain's previous launchpad (see MIGRATION.md). Amounts arrive in the
    /// quote's own units and 1e18-unit tokens.
    struct LedgerCoin {
        string name;
        string symbol;
        TokenMetadata meta;
        address creator;
        address feeRecipient; //  where the creator share accrues, when the ledger had an override (0 = the creator)
        FeeConfig fees; //        platformBps is ignored: the coin takes this launchpad's fee as it stands
        address quoteAsset; //    the quote the coin is funded in here: address(0) = native (msg.value), else an enabled ERC-20
        uint256 quoteAmount; //   the quote delivered: the reserve plus the two pots (native: must equal msg.value)
        uint256 virtualQuote; //  the ledger's virtual quote reserve
        uint256 sold; //          tokens that left its curve: what holders own (delivered by migrateToken/migrateBalances) plus `burned`
        uint256 burned; //        bought back and burned there: burned here too at birth
        uint256 poolToken; //     a coin that graduated there: the token side of its locked pool (0 = still on the curve)
        uint256 burnPot; //       its pots, unspent there, part of quoteAmount alongside the reserve
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
    /// May run a migration in (setMigrationRoot, migrateToken, migrateBalances)
    /// beside the owner: the deployer, for the days of a move, named by the
    /// owner — a timelock, so publicly ahead — and cleared when the migration
    /// closes.
    address public migrationOperator;

    // ------------------------------------------- migration to another chain
    /// The block from which this launchpad stands still so that its coins can
    /// be re-created elsewhere with the same holders and the same price: from
    /// it on, no creation, buy, sell or token transfer. 0 = none announced.
    /// Announced by the owner — a timelock, so the block is public for the
    /// timelock's delay before it can even be set.
    uint256 public freezeBlock;
    /// Coins whose reserve left for the other launchpad (migrateOut).
    mapping(address token => bool) public migratedOut;
    /// The migrator that seeded each graduated coin's pool: the one that can
    /// unlock it again for a migration, harvest its pool fees, buy it back.
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

    mapping(address token => FeeConfig) public feeConfig;
    /// Quote set aside to buy the coin back and burn it (buybackAndBurn).
    mapping(address token => uint256) public burnPot;
    /// Quote set aside for the coin's pool, joining its quote side at graduation.
    mapping(address token => uint256) public liquidityPot;
    /// Coins bought back and burned so far, and coins taken as tax on the
    /// pool and burned (the burn share, and whatever was unsold at a
    /// migration out): they left the curve (part of `sold`) and exist no
    /// more, so holders own `sold` less this.
    mapping(address token => uint256) public burned;
    /// The first block a coin's next buyback may happen in: one a block, a slice at a time.
    mapping(address token => uint256) public nextBurnBlock;
    address[] public allTokens;

    // ------------------------------------------------------ fees on the pool
    /// Coins taken as the launchpad's fee on pool trades, not yet sold for
    /// quote: the migrator's harvest sells them and pays the treasury.
    mapping(address token => uint256) public taxTreasury;
    /// Coins taken as the coin's own tax on pool trades, not yet realised:
    /// the harvest burns the burn share and sells the rest for the creator,
    /// the holders and the pool's liquidity.
    mapping(address token => uint256) public taxPot;
    /// A coin's pools: a trade that touches one is taxed, and a pool earns
    /// no cashback. The pool the migrator seeds is registered at graduation;
    /// the owner (a timelock, so publicly ahead) may register others.
    mapping(address token => mapping(address pool => bool)) public taxedPool;

    // ---------------------------------------------------------------- events

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, bool feesToHolders);
    event FeesConfigured(
        address indexed token,
        uint16 buyTaxBps,
        uint16 sellTaxBps,
        uint16 creatorBps,
        uint16 holdersBps,
        uint16 burnBps,
        uint16 liquidityBps,
        uint16 platformBps
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
    event CreatorFeesClaimed(address indexed creator, uint256 amount);
    event CashbackClaimed(address indexed token, address indexed holder, uint256 amount);
    event TreasuryUpdated(address treasury);
    event MigratorUpdated(address migrator);
    event QuoteAssetUpdated(address indexed asset, uint256 virtualReserve);
    event TokenMigrated(
        address indexed token, address indexed creator, uint256 virtualQuote, uint256 realQuote, uint256 sold
    );
    event MigrationBalances(address indexed token, uint256 holders, uint256 pending);
    event MigrationRootSet(bytes32 root, uint256 freezeHeight);
    event MigrationClosed();
    event MigrationOperatorUpdated(address operator);
    event FreezeAnnounced(uint256 freezeBlock);
    event FreezeCancelled();
    event MigratedOut(address indexed token, address indexed to, uint256 quoteAmount, uint256 tokensBurned);
    /// A pool trade paid its fee in coins: booked here, sold by the harvest.
    event Taxed(address indexed token, bool isBuy, uint256 amount);
    /// A harvest handed the pad the quote it realised, by destination.
    event PoolFee(address indexed token, uint256 toTreasury, uint256 toCreator, uint256 toHolders, uint256 toBurnPot);
    /// A pool of the coin: taxed from now on, no cashback.
    event PoolRegistered(address indexed token, address indexed pool);

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
    /// not the migrator that seeded this coin's pool.
    error NotMigrator();
    /// a harvest asks for more than a bucket holds, or burns more than the coin's share.
    error BadHarvest();
    /// an address that is not a pool of this coin.
    error BadPool();
    /// neither the owner nor the migration operator.
    error NotOperator();

    constructor(address treasury_) Ownable(msg.sender) {
        treasury = treasury_;
        // the native coin is a quote asset like any other, on from the start;
        // a pad quoted in an ERC-20 alone switches it off (setQuoteAsset(0, 0))
        quoteVirtualReserve[address(0)] = VIRTUAL_ETH;
        emit QuoteAssetUpdated(address(0), VIRTUAL_ETH);
    }

    // ---------------------------------------------------------------- shared

    /// @notice Whether this launchpad stands still: the freeze block was
    ///         announced and is reached.
    function frozen() public view returns (bool) {
        return freezeBlock != 0 && block.number >= freezeBlock;
    }

    /// Validate and record a coin's fee configuration; the launchpad's fee as
    /// it stands is stamped on the coin, whatever the caller passed.
    function _setFees(address token, FeeConfig memory fees) internal {
        if (
            fees.buyTaxBps > MAX_TAX_BPS || fees.sellTaxBps > MAX_TAX_BPS
                || uint256(fees.creatorBps) + fees.holdersBps + fees.burnBps + fees.liquidityBps != FEE_DENOMINATOR
        ) revert BadFeeConfig();
        fees.platformBps = uint16(feeBps);
        feeConfig[token] = fees;
        emit FeesConfigured(
            token,
            fees.buyTaxBps,
            fees.sellTaxBps,
            fees.creatorBps,
            fees.holdersBps,
            fees.burnBps,
            fees.liquidityBps,
            fees.platformBps
        );
    }

    /// @notice The curve sold out: close it and hand the reserve to the DEX,
    ///         in the same transaction and as one piece. A failing DEX leg
    ///         fails the trade that crossed the line, so a coin is never
    ///         graduated with its reserve waiting, unless no migrator is set
    ///         at all.
    function _graduate(address token, Curve storage c) internal {
        c.graduated = true;
        LaunchToken(token).setGraduated();
        emit Graduated(token, c.realEth);
        if (address(migrator) != address(0)) _doMigrate(token);
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
        address pool;
        if (c.quoteAsset == address(0)) {
            pool = migrator.migrate{value: ethAmount}(token, reserve, address(0), ethAmount);
        } else {
            IERC20(c.quoteAsset).safeTransfer(address(migrator), ethAmount);
            pool = migrator.migrate(token, reserve, c.quoteAsset, ethAmount);
        }
        // the pool is a counterparty from now on: taxed, and no cashback on what it holds
        if (pool != address(0)) _registerPool(token, pool);

        emit Migrated(token, reserve, ethAmount);
    }

    /// A pool of the coin, from now on: trades touching it pay the fees, and
    /// what it holds earns no cashback — taken off the eligible supply here,
    /// which counted it when it arrived. Set only, never cleared.
    function _registerPool(address token, address pool) internal {
        if (taxedPool[token][pool]) return;
        taxedPool[token][pool] = true;
        uint256 held = IERC20(token).balanceOf(pool);
        if (held != 0) eligibleSupply[token] -= held;
        emit PoolRegistered(token, pool);
    }

    /// Whether `account` earns cashback on `token`: everyone but the zero
    /// address, this contract, the coin's pools and its migrator.
    function _isEligible(address token, address account) internal view returns (bool) {
        return account != address(0) && account != address(this) && !taxedPool[token][account]
            && account != address(graduatedVia[token]);
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

    /// Splits a coin's tax as its FeeConfig says; returns what falls to the
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
        toTreasury += _creditShares(token, creator, asset, toCreator, toHolders);
        if (toLiquidity != 0) liquidityPot[token] += toLiquidity;
        if (toBurn != 0) burnPot[token] += toBurn;
    }

    /// Books the creator's share (pull-withdrawal) and the holders' (the
    /// cashback accumulator; to the treasury while there is no eligible
    /// supply). Returns what goes to the treasury.
    function _creditShares(address token, address creator, address asset, uint256 toCreator, uint256 toHolders)
        internal
        returns (uint256 toTreasury)
    {
        if (toCreator != 0) {
            address recipient = feeRecipient[token];
            if (recipient == address(0)) recipient = creator;
            creatorFees[recipient][asset] += toCreator;
        }
        if (toHolders != 0) {
            uint256 eligible = eligibleSupply[token];
            if (eligible < MIN_ELIGIBLE_SUPPLY) toTreasury = toHolders;
            else accCashbackPerShare[token] += (toHolders * ACC_PRECISION) / eligible;
        }
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
