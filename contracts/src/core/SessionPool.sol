// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Amm} from "../libraries/Amm.sol";
import {WadMath} from "../libraries/WadMath.sol";
import {Constants} from "../generated/Constants.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {ClaimToken} from "./ClaimToken.sol";
import {ReentrancyGuard} from "./ReentrancyGuard.sol";

/// @title SessionPool
/// @notice The claim pool: reserves, liquidity shares, seeding and trading.
/// @dev One concept, one file. `Session` owns the lifecycle and the collateral ledger; this owns the
///      pool the two legs trade against. The split exists because the two together exceed the
///      brief's 400-line file limit, and because the seam is real: the pool holds *claims*, never
///      collateral, so it has no view of solvency at all.
///
///      Every mutating function here follows checks-effects-interactions in that textual order. The
///      derived contract updates the collateral ledger *before* delegating, so the whole call is
///      effect-then-interaction rather than interaction-then-effect.
abstract contract SessionPool is ReentrancyGuard {
    /// @dev Thrown on a zero amount, where the arithmetic is undefined or the intent is unclear.
    error ZeroAmount();
    /// @dev Thrown when a deposit would move the pool's price, which the LP deposit rule forbids.
    error PoolRatioMismatch(
        uint256 longIn, uint256 shortIn, uint256 longReserve, uint256 shortReserve
    );
    /// @dev Thrown when an action needs a seeded pool and there is none.
    error PoolDepthZero();
    /// @dev Thrown when a trade would deliver less than the caller's floor.
    error SlippageExceeded(uint256 received, uint256 minimum);
    /// @dev Thrown when an ERC-20 interaction reports failure rather than reverting.
    error ClaimTransferFailed();
    /// @dev Thrown at construction when the collateral's decimals are not the expected ones. Guard
    ///      G9: without it an 18-decimal collateral produces a session wrong by 1e12 with no revert,
    ///      no event and no signal -- the largest silent assumption in the contract.
    error CollateralDecimalsUnsupported(uint256 supplied, uint256 supported);

    /// @dev Emitted when liquidity is added to the pool.
    event PoolSeeded(uint256 longIn, uint256 shortIn, uint256 longReserve, uint256 shortReserve);
    /// @dev Emitted when liquidity shares are minted.
    event PoolSharesMinted(
        address indexed provider, uint256 shares, uint256 longIn, uint256 shortIn
    );
    /// @dev Emitted when liquidity shares are redeemed after settlement.
    event PoolWithdrawn(address indexed provider, uint256 shares, uint256 payout);
    /// @dev Emitted on every trade, so the price path is reconstructible from logs alone.
    event Traded(address indexed trader, bool boughtLong, uint256 collateralIn, uint256 claimOut);

    /// @notice The collateral token. USDG at six decimals on the deployment chain.
    IERC20 public immutable collateral;
    /// @notice The long leg, `GAP-L`.
    ClaimToken public immutable longClaim;
    /// @notice The short leg, `GAP-S`.
    ClaimToken public immutable shortClaim;

    /// @dev Storage layout of the derived contract, which inherits this one:
    ///        slot 0: the reentrancy guard (from `ReentrancyGuard`)
    ///        slot 1: longReserve
    ///        slot 2: shortReserve
    ///        slot 3: totalPoolShares
    ///        slot 4..: poolShares
    ///        slot 5: poolFees
    ///      The claim tokens and the collateral are immutable and occupy no storage.
    /// @notice The pool's long reserve.
    uint256 public longReserve;
    /// @notice The pool's short reserve.
    uint256 public shortReserve;
    /// @notice Total liquidity shares outstanding. One share is one claim unit of pool.
    uint256 public totalPoolShares;
    /// @notice Liquidity shares, which own the pool's claim balances.
    /// @dev The pool holds claims, not collateral, so at settlement those claims are worth
    ///      `a * PI_L + b * PI_S` and something has to own that. The paper's §6.4 writes the LP's
    ///      share as `w` without specifying the mechanism, and the brief's Session API lists no
    ///      share token and no pool-withdrawal function. Recorded as F19 in DESIGN_NOTES.md.
    mapping(address provider => uint256) public poolShares;
    /// @notice Trading fees accrued to the pool and not yet distributed. Collateral units.
    /// @dev The trading fee (paper Eq 19 scaled by Eq 20) is liquidity-provider compensation, not
    ///      protocol margin, so it accrues to the pool rather than to `collectedFees`. It is kept
    ///      as a collateral line rather than minted into the reserves: minting claims into the pool
    ///      would move the marginal price toward one half, and the price is the fee's own
    ///      volatility signal -- a fee that distorts the signal it scales with is a feedback loop.
    ///      Distributed to share holders at settlement with the claims (F97 ruling).
    uint256 public poolFees;

    /// @param collateral_ the collateral token; its decimals are asserted here, once, for the whole
    ///        session and both claim legs.
    constructor(IERC20 collateral_) {
        uint256 suppliedDecimals = collateral_.decimals();
        if (suppliedDecimals != Constants.COLLATERAL_DECIMALS) {
            revert CollateralDecimalsUnsupported(suppliedDecimals, Constants.COLLATERAL_DECIMALS);
        }
        collateral = collateral_;
        // The claims share the collateral's scale: a claim is a claim on collateral units, so a
        // fixed 18 decimals against a 6-decimal collateral would put a 1e12 factor between a pool
        // reserve and a payout.
        longClaim = new ClaimToken("BELL GAP Long", "GAP-L", uint8(suppliedDecimals), address(this));
        shortClaim =
            new ClaimToken("BELL GAP Short", "GAP-S", uint8(suppliedDecimals), address(this));
    }

    // ---------------------------------------------------------------- liquidity

    /// @notice Deposit both legs into the pool.
    /// @dev The first deposit sets the price and the share scale. Every later deposit must match the
    ///      pool's prevailing ratio *exactly*, because a deposit that moves the price is an arbitrage
    ///      handed to whoever takes the other side of it: the depositor would be buying the cheap leg
    ///      at her own expense. Verified in the paper at zero relative price movement on both add and
    ///      remove (check C7).
    function _seedPool(address provider, uint256 longIn, uint256 shortIn)
        internal
        returns (uint256 shares)
    {
        if (longIn == 0 || shortIn == 0) revert ZeroAmount();
        if (totalPoolShares == 0) {
            longReserve = longIn;
            shortReserve = shortIn;
            shares = longIn + shortIn;
        } else {
            if (longIn * shortReserve != shortIn * longReserve) {
                revert PoolRatioMismatch(longIn, shortIn, longReserve, shortReserve);
            }
            shares = (longIn * totalPoolShares) / longReserve;
            if (shares == 0) revert ZeroAmount();
            longReserve += longIn;
            shortReserve += shortIn;
        }
        totalPoolShares += shares;
        poolShares[provider] += shares;

        _pullClaim(longClaim, provider, longIn);
        _pullClaim(shortClaim, provider, shortIn);
        emit PoolSeeded(longIn, shortIn, longReserve, shortReserve);
        emit PoolSharesMinted(provider, shares, longIn, shortIn);
    }

    /// @notice Redeem liquidity shares for the pool's claims at the settled payoff.
    /// @dev Post-settlement only, because the pool's claims are only worth something once the payoff
    ///      is fixed. The last withdrawal takes the remainder rather than a proportional slice, so
    ///      integer rounding cannot strand a claim and make `close()` permanently unreachable.
    function _withdrawPool(address provider, uint256 payoffLongWad)
        internal
        returns (uint256 payout)
    {
        uint256 shares = poolShares[provider];
        if (shares == 0) revert ZeroAmount();

        uint256 poolLong = longClaim.balanceOf(address(this));
        uint256 poolShort = shortClaim.balanceOf(address(this));
        uint256 longOut;
        uint256 shortOut;
        if (shares == totalPoolShares) {
            longOut = poolLong;
            shortOut = poolShort;
        } else {
            longOut = (poolLong * shares) / totalPoolShares;
            shortOut = (poolShort * shares) / totalPoolShares;
        }
        payout = WadMath.mulWad(longOut, payoffLongWad)
            + WadMath.mulWad(shortOut, Constants.WAD - payoffLongWad);

        // The trading fees accrued to the pool are distributed with the claims, the last
        // withdrawal taking the remainder so integer rounding cannot strand a wei and make
        // `close()` unreachable. The fee line is a pool asset like the claims, so the same
        // proportional rule applies to both.
        uint256 feeOut;
        if (shares == totalPoolShares) {
            feeOut = poolFees;
        } else {
            feeOut = (poolFees * shares) / totalPoolShares;
        }
        payout += feeOut;

        poolShares[provider] = 0;
        totalPoolShares -= shares;
        poolFees -= feeOut;
        longClaim.burn(address(this), longOut);
        shortClaim.burn(address(this), shortOut);
        _pushCollateral(provider, payout);
        emit PoolWithdrawn(provider, shares, payout);
    }

    // ---------------------------------------------------------------- trading

    /// @notice Acquire long claims by depositing collateral.
    /// @param feeAmount the trading fee on the deposit, pulled with the collateral and accrued to
    ///        the pool's `poolFees` line. The reserves move only by the swap -- the fee is a
    ///        collateral line, never claims, so the marginal price is untouched by it.
    /// @return longFromSwap the long claims delivered from the pool, excluding the minted leg.
    /// @dev The paper describes this as minting both legs to the trader and then swapping her short
    ///      leg into the pool. Minting the short leg directly into the pool is the same net effect
    ///      with one fewer interaction, and it spares the trader an `approve` she would otherwise
    ///      have to grant inside the same transaction.
    function _acquireLong(
        address trader,
        uint256 collateralIn,
        uint256 feeAmount,
        uint256 minTotalLong
    ) internal returns (uint256 longFromSwap) {
        if (longReserve == 0 || shortReserve == 0) revert PoolDepthZero();
        longFromSwap = Amm.longOutForShortIn(longReserve, shortReserve, collateralIn);
        // The floor is checked against the whole delivered quantity -- the minted leg plus the
        // swapped one -- and before the reserves move, so the check precedes both the effect and the
        // interaction rather than relying on the revert to undo them.
        uint256 totalLong = collateralIn + longFromSwap;
        if (totalLong < minTotalLong) revert SlippageExceeded(totalLong, minTotalLong);

        longReserve -= longFromSwap;
        shortReserve += collateralIn;

        _pullCollateral(trader, collateralIn + feeAmount);
        if (feeAmount != 0) poolFees += feeAmount;
        longClaim.mint(trader, collateralIn);
        shortClaim.mint(address(this), collateralIn);
        if (!longClaim.transfer(trader, longFromSwap)) revert ClaimTransferFailed();
    }

    /// @notice Acquire short claims by depositing collateral. The mirror of `_acquireLong`.
    function _acquireShort(
        address trader,
        uint256 collateralIn,
        uint256 feeAmount,
        uint256 minTotalShort
    ) internal returns (uint256 shortFromSwap) {
        if (longReserve == 0 || shortReserve == 0) revert PoolDepthZero();
        shortFromSwap = Amm.shortOutForLongIn(longReserve, shortReserve, collateralIn);
        uint256 totalShort = collateralIn + shortFromSwap;
        if (totalShort < minTotalShort) revert SlippageExceeded(totalShort, minTotalShort);

        longReserve += collateralIn;
        shortReserve -= shortFromSwap;

        _pullCollateral(trader, collateralIn + feeAmount);
        if (feeAmount != 0) poolFees += feeAmount;
        shortClaim.mint(trader, collateralIn);
        longClaim.mint(address(this), collateralIn);
        if (!shortClaim.transfer(trader, shortFromSwap)) revert ClaimTransferFailed();
    }

    /// @notice Swap short claims already held for long claims from the pool.
    /// @dev The pool's price is unaffected by the pair accounting, so this path is available to any
    ///      holder and is the one that requires an allowance.
    ///
    ///      The depth guard is here for the same reason it is in `_acquireLong`, `_acquireShort` and
    ///      `_poolPriceLongWad`, and its absence was a real hole rather than a missing line: with one
    ///      reserve empty, `Amm.longOutForShortIn` would price the swap against a pool that has
    ///      nothing on one side, and the trade would take the whole of the other. Found by the
    ///      invariant handler once `Amm` began refusing the degenerate case; the pool should never
    ///      have been the second line of defence here.
    function _swapShortForLong(address trader, uint256 shortIn) internal returns (uint256 longOut) {
        if (longReserve == 0 || shortReserve == 0) revert PoolDepthZero();
        longOut = Amm.longOutForShortIn(longReserve, shortReserve, shortIn);
        longReserve -= longOut;
        shortReserve += shortIn;
        _pullClaim(shortClaim, trader, shortIn);
        if (!longClaim.transfer(trader, longOut)) revert ClaimTransferFailed();
    }

    /// @notice Swap long claims already held for short claims from the pool.
    /// @dev Guarded for the mirror reason. This is the direction that can *create* the degenerate
    ///      state, because it draws its payout out of the short reserve while adding to the long one.
    function _swapLongForShort(address trader, uint256 longIn) internal returns (uint256 shortOut) {
        if (longReserve == 0 || shortReserve == 0) revert PoolDepthZero();
        shortOut = Amm.shortOutForLongIn(longReserve, shortReserve, longIn);
        longReserve += longIn;
        shortReserve -= shortOut;
        _pullClaim(longClaim, trader, longIn);
        if (!shortClaim.transfer(trader, shortOut)) revert ClaimTransferFailed();
    }

    // ---------------------------------------------------------------- views

    /// @notice The pool's marginal price of one long claim, in collateral per claim.
    /// @dev Reverts on an unseeded pool rather than returning zero, because a zero price is a free
    ///      claim and every caller of this would be pricing against it.
    function _poolPriceLongWad() internal view returns (uint256) {
        if (longReserve == 0 || shortReserve == 0) revert PoolDepthZero();
        return Amm.priceLongWad(longReserve, shortReserve);
    }

    /// @notice The pool depth, `a + b`, which is the denominator of the slippage law.
    function _poolDepth() internal view returns (uint256) {
        return longReserve + shortReserve;
    }

    // ---------------------------------------------------------------- interactions

    function _pullCollateral(address from, uint256 amount) private {
        if (!collateral.transferFrom(from, address(this), amount)) revert ClaimTransferFailed();
    }

    /// @dev Internal rather than private because the derived contract pays claims and redemption
    ///      fees out of the same collateral.
    function _pushCollateral(address to, uint256 amount) internal {
        if (!collateral.transfer(to, amount)) revert ClaimTransferFailed();
    }

    function _pullClaim(ClaimToken claim, address from, uint256 amount) private {
        if (!claim.transferFrom(from, address(this), amount)) revert ClaimTransferFailed();
    }
}
