// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "openzeppelin-contracts/contracts/utils/math/Math.sol";
import {LaunchpadBase} from "./LaunchpadBase.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {IDexMigrator, IDexMigratorUnlock} from "./interfaces/IDexMigrator.sol";

/// @title LaunchpadMigration
/// @notice The Launchpad's migration surface, run in the Launchpad's storage
///         by delegatecall (its fallback): coins arriving from a frozen ledger
///         or launchpad elsewhere (migrateToken, migrateBalances), and the
///         freeze and migrateOut that let this launchpad's coins leave for
///         another. Never called on its own address: its own storage is never
///         written to anything that matters, and every function below reads
///         and writes the Launchpad's. See ILaunchpadMigration for the ABI.
contract LaunchpadMigration is LaunchpadBase {
    using SafeERC20 for IERC20;

    constructor() LaunchpadBase(address(0)) {}

    modifier onlyOperator() {
        if (msg.sender != owner() && msg.sender != migrationOperator) revert NotOperator();
        _;
    }

    // ------------------------------------------- migration from a ledger

    /// @notice Owner only: who may run the migration in beside the owner —
    ///         the deployer, for the days of a move; the owner is a timelock,
    ///         so the name is public a delay ahead. Cleared by closeMigration.
    function setMigrationOperator(address operator) external onlyOwner {
        migrationOperator = operator;
        emit MigrationOperatorUpdated(operator);
    }

    /// @notice Open the migration from a frozen ledger: its state root and
    ///         the block it froze at, once and for all. Every migrateToken
    ///         call must follow this, and anyone can replay the ledger to
    ///         this root to check what was migrated.
    function setMigrationRoot(bytes32 root, uint256 freezeHeight) external onlyOperator {
        if (root == bytes32(0) || migrationRoot != bytes32(0)) revert BadMigration();
        migrationRoot = root;
        migrationFreezeHeight = freezeHeight;
        emit MigrationRootSet(root, freezeHeight);
    }

    /// @notice End the migration: no coin can be migrated after this, ever,
    ///         and the operator's role ends with it. Balances still pending
    ///         for coins already migrated can still be delivered by the owner.
    function closeMigration() external onlyOwner {
        migrationClosed = true;
        migrationOperator = address(0);
        emit MigrationClosed();
        emit MigrationOperatorUpdated(address(0));
    }

    /// @notice Once per coin: re-create a coin that lived on a frozen ledger
    ///         or launchpad exactly as it recorded it, so trading continues
    ///         here at the same price. The quote actually in its curve and
    ///         its pots arrive as `coin.quoteAmount`: as msg.value for a
    ///         native quote, pulled from the caller for an enabled ERC-20.
    ///         `holders`/`balances` deliver what the ledger sold, here and,
    ///         for large holder sets, in further migrateBalances calls. Buys
    ///         and sells open once every token is delivered. Cashback and
    ///         creator fees accrued on the ledger are paid out there. A coin
    ///         that graduated on the ledger comes with its locked pool
    ///         (`poolToken` tokens against the quote): it graduates here as
    ///         soon as its holders are served and that pool goes to the DEX,
    ///         and its fees go on there.
    function migrateToken(LedgerCoin calldata coin, address[] calldata holders, uint256[] calldata balances)
        external
        payable
        onlyOperator
        nonReentrant
        returns (address token)
    {
        if (freezeBlock != 0) revert CreationClosed();
        if (coin.quoteAsset == address(0)) {
            if (msg.value != coin.quoteAmount) revert WrongPayment();
        } else {
            if (msg.value != 0 || quoteVirtualReserve[coin.quoteAsset] == 0) revert WrongPayment();
            IERC20(coin.quoteAsset).safeTransferFrom(msg.sender, address(this), coin.quoteAmount);
        }
        _checkLedgerCoin(coin, holders.length);
        token = tokenFactory.create(coin.name, coin.symbol, TOTAL_SUPPLY);
        _claimTicker(coin.symbol, token);
        curves[token] = _ledgerCurve(coin);
        tokenMetadata[token] = coin.meta;
        if (coin.feeRecipient != address(0)) feeRecipient[token] = coin.feeRecipient;
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
    function _checkLedgerCoin(LedgerCoin calldata coin, uint256 holderCount) internal pure {
        if (coin.creator == address(0) || coin.virtualQuote == 0 || coin.burned > coin.sold) revert BadMigration();
        uint256 reserve = _ledgerReserve(coin); // the quote delivered less the pots
        if (coin.poolToken != 0) {
            if (coin.sold + coin.poolToken > TOTAL_SUPPLY || reserve == 0) revert BadMigration();
        } else if (coin.sold > CURVE_SUPPLY) {
            revert BadMigration();
        } else if (coin.sold != 0) {
            // a constant-product curve holds exactly virtual * sold / (VIRTUAL_TOKEN - sold)
            // of real quote (the ledger rounds each trade by at most one unit): the
            // coin must arrive with that much, no less (sells could not be paid) and
            // no more (the price would be wrong). Dust: a millionth of a native coin,
            // one unit of an ERC-20 quote (cbLTC counts in satoshis)
            uint256 expected = Math.mulDiv(coin.virtualQuote, coin.sold, VIRTUAL_TOKEN - coin.sold);
            uint256 tolerance = expected / 200 + (coin.quoteAsset == address(0) ? 1e12 : 1); // 0.5% plus dust
            if (reserve + tolerance < expected || reserve > expected + tolerance) revert WrongQuote();
        }
        if (coin.sold == 0 && (reserve != 0 || holderCount != 0)) revert BadMigration(); // an untraded coin
    }

    /// The reserve a ledger coin arrives with: the quote delivered less its pots.
    function _ledgerReserve(LedgerCoin calldata coin) internal pure returns (uint256) {
        uint256 pots = coin.burnPot + coin.liquidityPot;
        if (coin.quoteAmount < pots) revert BadMigration();
        return coin.quoteAmount - pots;
    }

    /// The curve as the ledger left it. A pooled coin's curve is complete:
    /// it graduates once its holders are served (see _migrateBalances).
    function _ledgerCurve(LedgerCoin calldata coin) internal pure returns (Curve memory) {
        bool pooled = coin.poolToken != 0;
        uint256 reserve = _ledgerReserve(coin);
        return Curve({
            vEth: coin.virtualQuote + reserve,
            vToken: pooled ? VIRTUAL_TOKEN - CURVE_SUPPLY : VIRTUAL_TOKEN - coin.sold,
            realEth: reserve,
            sold: pooled ? CURVE_SUPPLY : coin.sold,
            graduated: false,
            creator: coin.creator,
            quoteAsset: coin.quoteAsset
        });
    }

    /// @notice Deliver more of a migrated coin's balances (owner or operator).
    function migrateBalances(address token, address[] calldata holders, uint256[] calldata balances)
        external
        onlyOperator
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

    // ------------------------------------------- migration to another chain

    /// @notice Announce the block from which the launchpad stands still, so
    ///         its coins can be re-created elsewhere: the block must not be
    ///         past, only one freeze can be announced at a time, and not
    ///         over a migrated coin still delivering its holders. From the
    ///         announcement on no new coin is created here, and the harvest
    ///         of every coin's pool fees runs unbounded, so nothing is left
    ///         unsold when the freeze lands. The owner is a timelock, so the
    ///         announcement is public for the delay before it can be made;
    ///         and since cancelFreeze takes the same delay, a freeze can only
    ///         be called off if its block lies more than one delay past the
    ///         announcement.
    function announceFreeze(uint256 atBlock) external onlyOwner {
        if (freezeBlock != 0 || atBlock < block.number) revert BadFreeze();
        if (pendingCoins != 0) revert MigrationPending();
        freezeBlock = atBlock;
        emit FreezeAnnounced(atBlock);
    }

    /// @notice Withdraw an announced freeze before it lands (the other side
    ///         is late); after it lands there is no way back.
    function cancelFreeze() external onlyOwner {
        if (freezeBlock == 0 || block.number >= freezeBlock) revert BadFreeze();
        freezeBlock = 0;
        emit FreezeCancelled();
    }

    /// @notice Once frozen, take a coin's quote out to bring it where the
    ///         coin is re-created: a curve coin's reserve as it stands; a
    ///         graduated coin's pool, unlocked by the migrator that seeded it
    ///         — its quote side leaves, its token side comes back here and
    ///         is burned, so the supply mirrors what holders own, and the
    ///         pool stays open to withdrawals (migratedPair). Pool fees
    ///         still unsold (taxTreasury, taxPot: dust, after the unbounded
    ///         harvests the announcement allows) are burned too. The
    ///         migrator must be able to give the pool back
    ///         (IDexMigratorUnlock): one that cannot makes this revert, and
    ///         the coin stays. Cashback and creator fees accrued here stay
    ///         claimable here, whatever their quote. Once per coin; this is
    ///         the operator's custody of the reserve, announced through the
    ///         timelock like the freeze itself.
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
        // fees taken in coins and never sold: gone with the coin
        uint256 unsold = taxTreasury[token] + taxPot[token];
        if (unsold != 0) {
            taxTreasury[token] = 0;
            taxPot[token] = 0;
            burned[token] += unsold;
            LaunchToken(token).burn(unsold);
        }

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
        tokensBurned += unsold;
        emit MigratedOut(token, to, quoteOut, tokensBurned);
    }
}
