// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeModel} from "../libraries/FeeModel.sol";
import {Stat} from "../libraries/Stat.sol";
import {WadMath} from "../libraries/WadMath.sol";
import {Constants} from "../generated/Constants.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SessionPool} from "./SessionPool.sol";

/// @title Session
/// @notice One claim pair: the lifecycle, the collateral ledger, and settlement.
/// @dev The lifecycle is an explicit enum rather than a set of booleans, because a boolean makes the
///      legal transition set unreadable and is how "claim twice" bugs are born. Every mutating
///      function declares the state it is legal in, and the modifier is named for the state rather
///      than for the operation.
///
///      `Open -> Expired -> Settled -> Claimed`. No transition moves backwards, and none is reachable
///      twice.
///
///      The pool itself lives in `SessionPool`, which this extends. The session holds the collateral
///      ledger and knows about solvency; the pool holds claims and knows nothing about it.
contract Session is SessionPool {
    /// @notice The lifecycle. Declared in order; the enum's numeric value is never persisted.
    enum State {
        /// @dev Pairs can be minted, redeemed and traded.
        Open,
        /// @dev The expiry has passed. Nothing trades; settlement is pending.
        Expired,
        /// @dev The payoff is fixed. Claims can be redeemed.
        Settled,
        /// @dev Every claim is redeemed and the collateral fully distributed. Terminal.
        Claimed
    }

    /// @dev Thrown when a caller other than the factory attempts a factory-only action.
    error NotFactory(address caller);
    /// @dev Thrown when a caller other than the reference registry attempts to settle.
    error NotReferenceRegistry(address caller);
    /// @dev Thrown when a function is called outside a state it is legal in.
    error WrongState(State current, State required);
    /// @dev Thrown when a mint would push the session past its notional cap.
    error NotionalCapExceeded(uint256 wouldBe, uint256 cap);
    /// @dev Thrown when settling before the expiry has passed.
    error ExpiryNotReached(uint256 expiry, uint256 nowTimestamp);
    /// @dev Thrown when a payoff above the collateral unit is presented. The cap is the liability
    ///      bound; a payoff above one would make a pair worth more than it holds.
    error PayoffAboveCollateral(uint256 payoff, uint256 collateralUnit);
    /// @dev Thrown when a settlement would leave collateral unaccounted for.
    error InsufficientCollateral(uint256 available, uint256 required);
    /// @dev Thrown when closing while claims are still outstanding.
    error ClaimsOutstanding(uint256 longSupply, uint256 shortSupply);
    /// @dev Thrown when a required address is zero. A zero reference registry would make the session
    ///      permanently unsettleable, and a zero reference token would make it unidentifiable, so
    ///      both are refused at construction rather than discovered at expiry.
    error ZeroAddress();

    /// @dev Emitted on every lifecycle transition, so the state history is reconstructible.
    event Settled(uint256 payoffLongWad, bool staleReference);
    event Closed(uint256 pairsOutstanding);
    event FeesCollected(address indexed to, uint256 amount);

    /// @notice The reference token whose gap this session settles on.
    address public immutable referenceToken;
    /// @notice The factory that deployed this session, and the only address that may collect fees.
    address public immutable factory;
    /// @notice The contract permitted to settle this session.
    address public immutable referenceRegistry;
    /// @notice The leverage, at WAD scale.
    uint256 public immutable lamWad;
    /// @dev `lam * E[min(|G|, 1/lam)]` at `sigma_ref` (Eq 12, F11-pinned), computed in the
    ///      constructor; the trading fee's volatility multiplier divides the pool price by it (F97).
    uint256 public immutable pLRefWad;
    /// @notice The moment after which the session stops trading.
    uint256 public immutable expiryTimestamp;
    /// @notice The instant of deployment, used for the term-prorated fee.
    uint256 public immutable openTimestamp;
    /// @notice The ceiling on pairs outstanding, in collateral units.
    uint256 public immutable notionalCapWad;

    /// @dev Storage layout, continuing the pool's. The reentrancy guard is slot 0.
    ///        slot 1: longReserve          (SessionPool)
    ///        slot 2: shortReserve         (SessionPool)
    ///        slot 3: totalPoolShares      (SessionPool)
    ///        slot 4..: poolShares         (SessionPool)
    ///        slot 5: poolFees             (SessionPool)
    ///        slot 6: state
    ///        slot 7: totalPairSupply
    ///        slot 8: collectedFees
    ///        slot 9: payoffLongWad
    ///        slot 10: settledOnStaleReference
    /// @notice The lifecycle state.
    State public state;
    /// @notice Pairs outstanding. The session's collateral obligation, unit for unit.
    uint256 public totalPairSupply;
    /// @notice Redemption fees accrued and not yet swept.
    uint256 public collectedFees;
    /// @notice The long leg's terminal payoff, fixed at settlement.
    uint256 public payoffLongWad;
    /// @notice Whether settlement used a print outside its freshness bound.
    bool public settledOnStaleReference;

    /// @dev Every mutating function declares its legal state, and the modifier names the state
    ///      rather than the operation. `inState(State.Open)` is readable as a precondition; a
    ///      `notSettled` modifier is not, and it silently admits every state added later.
    modifier inState(State required) {
        if (state != required) revert WrongState(state, required);
        _;
    }

    constructor(
        IERC20 collateral_,
        address referenceToken_,
        uint256 lamWad_,
        uint256 expiryTimestamp_,
        uint256 notionalCapWad_,
        address referenceRegistry_
    ) SessionPool(collateral_) {
        if (lamWad_ == 0) revert ZeroAmount();
        if (referenceToken_ == address(0) || referenceRegistry_ == address(0)) {
            revert ZeroAddress();
        }
        if (expiryTimestamp_ <= block.timestamp) {
            revert ExpiryNotReached(expiryTimestamp_, block.timestamp);
        }
        referenceToken = referenceToken_;
        factory = msg.sender;
        referenceRegistry = referenceRegistry_;
        lamWad = lamWad_;
        pLRefWad = WadMath.mulWad(
            lamWad_,
            Stat.truncatedAbsMoment(lamWad_, 0, Constants.TRADING_FEE_REFERENCE_VOLATILITY_WAD)
        );
        expiryTimestamp = expiryTimestamp_;
        openTimestamp = block.timestamp;
        notionalCapWad = notionalCapWad_;
    }

    // ---------------------------------------------------------------- mint and redeem

    /// @notice Deposit collateral and receive one long and one short claim per unit.
    function mintPair(uint256 amount) external nonReentrant inState(State.Open) {
        _mintPair(msg.sender, amount);
    }

    /// @notice Mint a pair to an arbitrary recipient. Factory only, for the initial seed.
    /// @dev Separate from `mintPair` so the factory can seed a pool without holding the collateral
    ///      itself, and so the permission is explicit rather than implied by `msg.sender`.
    function mintPairFromFactory(address to, uint256 amount)
        external
        nonReentrant
        inState(State.Open)
    {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        _mintPair(to, amount);
    }

    /// @notice Burn one long and one short and take back the collateral, less the protocol fee.
    /// @dev The fee is the term-prorated annualised rate of paper Eq (17), capped at `0.05 * pL` by
    ///      Eq (18). `pL` is the pool's marginal price, which is the only premium the session can
    ///      observe on chain; a session with no seeded pool therefore has no premium to cap against
    ///      and refuses rather than charging an uncapped rate. That is a fail-closed choice, and it
    ///      is recorded in DESIGN_NOTES.md.
    function redeemPair(uint256 amount) external nonReentrant inState(State.Open) {
        if (amount == 0) revert ZeroAmount();
        // The fee function returns a *rate* at WAD scale, not an amount. Applying it directly would
        // subtract a fraction from a collateral quantity and underflow for every realistic amount.
        uint256 feeWad = FeeModel.protocolFeeWad(_poolPriceLongWad(), termHoursWad());
        uint256 feeAmount = WadMath.mulWad(amount, feeWad);

        totalPairSupply -= amount;
        collectedFees += feeAmount;

        longClaim.burn(msg.sender, amount);
        shortClaim.burn(msg.sender, amount);
        _pushCollateral(msg.sender, amount - feeAmount);
    }

    // ---------------------------------------------------------------- trading

    /// @notice Acquire long claims by depositing collateral.
    /// @param minLongOut the caller's floor on total long claims received.
    function buyLong(uint256 collateralIn, uint256 minLongOut)
        external
        nonReentrant
        inState(State.Open)
    {
        uint256 fromSwap = _reserveForMint(collateralIn, minLongOut, true);
        emit Traded(msg.sender, true, collateralIn, collateralIn + fromSwap);
    }

    /// @notice Acquire short claims by depositing collateral. The mirror of `buyLong`.
    function buyShort(uint256 collateralIn, uint256 minShortOut)
        external
        nonReentrant
        inState(State.Open)
    {
        uint256 fromSwap = _reserveForMint(collateralIn, minShortOut, false);
        emit Traded(msg.sender, false, collateralIn, collateralIn + fromSwap);
    }

    /// @notice Swap short claims already held for long claims from the pool.
    function swapShortForLong(uint256 shortIn, uint256 minLongOut)
        external
        nonReentrant
        inState(State.Open)
    {
        if (shortIn == 0) revert ZeroAmount();
        uint256 longOut = _swapShortForLong(msg.sender, shortIn);
        if (longOut < minLongOut) revert SlippageExceeded(longOut, minLongOut);
    }

    /// @notice Swap long claims already held for short claims from the pool.
    function swapLongForShort(uint256 longIn, uint256 minShortOut)
        external
        nonReentrant
        inState(State.Open)
    {
        if (longIn == 0) revert ZeroAmount();
        uint256 shortOut = _swapLongForShort(msg.sender, longIn);
        if (shortOut < minShortOut) revert SlippageExceeded(shortOut, minShortOut);
    }

    /// @notice Deposit both legs into the pool.
    function seedPool(uint256 longIn, uint256 shortIn) external nonReentrant inState(State.Open) {
        _seedPool(msg.sender, longIn, shortIn);
    }

    /// @notice Sweep accrued redemption fees. Factory only.
    function collectFees(address to) external nonReentrant {
        if (msg.sender != factory) revert NotFactory(msg.sender);
        uint256 amount = collectedFees;
        collectedFees = 0;
        _pushCollateral(to, amount);
        emit FeesCollected(to, amount);
    }

    // ---------------------------------------------------------------- lifecycle

    /// @notice Move the session out of `Open` once its expiry has passed.
    /// @dev Permissionless: the transition is a function of the clock and carries no discretion, so
    ///      gating it would add a liveness dependency for no benefit.
    function expire() external {
        if (state != State.Open) revert WrongState(state, State.Open);
        if (block.timestamp < expiryTimestamp) {
            revert ExpiryNotReached(expiryTimestamp, block.timestamp);
        }
        state = State.Expired;
    }

    /// @notice Fix the payoff. Reference registry only.
    /// @param payoffWad the long leg's terminal payoff at WAD scale, in `[0, 1e18]`.
    /// @param staleReference whether the selected print was outside its freshness bound.
    /// @dev The session does not evaluate the payoff itself. The reference registry selects the print
    ///      and computes the payoff, and the split is deliberate: it keeps the settlement procedure --
    ///      the protocol's entire residual risk -- in one auditable place rather than spread across
    ///      the contracts that depend on its output.
    function settle(uint256 payoffWad, bool staleReference) external {
        if (msg.sender != referenceRegistry) revert NotReferenceRegistry(msg.sender);
        if (state != State.Expired) revert WrongState(state, State.Expired);
        if (payoffWad > Constants.WAD) revert PayoffAboveCollateral(payoffWad, Constants.WAD);
        payoffLongWad = payoffWad;
        settledOnStaleReference = staleReference;
        state = State.Settled;
        emit Settled(payoffWad, staleReference);
    }

    /// @notice Redeem every claim the caller holds at the settled payoff.
    /// @dev Permissionless and caller-independent: the payout is a function of the caller's balances
    ///      and the fixed payoff, so there is no discretion to gate and no ordering to exploit.
    function claim() external nonReentrant inState(State.Settled) {
        uint256 longBalance = longClaim.balanceOf(msg.sender);
        uint256 shortBalance = shortClaim.balanceOf(msg.sender);
        if (longBalance == 0 && shortBalance == 0) revert ZeroAmount();

        uint256 payout = WadMath.mulWad(longBalance, payoffLongWad)
            + WadMath.mulWad(shortBalance, Constants.WAD - payoffLongWad);

        longClaim.burn(msg.sender, longBalance);
        shortClaim.burn(msg.sender, shortBalance);
        _pushCollateral(msg.sender, payout);
    }

    /// @notice Redeem liquidity shares for the pool's claims at the settled payoff.
    function withdrawPool() external nonReentrant inState(State.Settled) {
        _withdrawPool(msg.sender, payoffLongWad);
    }

    /// @notice Freeze the session once every claim is redeemed. Terminal.
    /// @dev Requires both claim supplies to be zero *and* the collateral to be fully distributed apart
    ///      from swept fees. The second check is what catches an accounting error that leaves a
    ///      residual behind: a session that closes with collateral stranded is a session whose
    ///      sum-to-one arithmetic did not hold.
    function close() external {
        if (state != State.Settled) revert WrongState(state, State.Settled);
        uint256 longSupply = longClaim.totalSupply();
        uint256 shortSupply = shortClaim.totalSupply();
        if (longSupply != 0 || shortSupply != 0) revert ClaimsOutstanding(longSupply, shortSupply);

        uint256 remaining = collateral.balanceOf(address(this));
        if (remaining != collectedFees) revert InsufficientCollateral(remaining, collectedFees);
        state = State.Claimed;
        emit Closed(totalPairSupply);
    }

    // ---------------------------------------------------------------- views

    /// @notice The pool's marginal price of one long claim, in collateral per claim.
    function poolPriceLongWad() external view returns (uint256) {
        return _poolPriceLongWad();
    }

    /// @notice The pool depth, `a + b`, which is the denominator of the slippage law.
    function poolDepth() external view returns (uint256) {
        return _poolDepth();
    }

    /// @notice The session's term in hours, at WAD scale.
    /// @dev WAD-scale hours because the overnight session is 17.5 hours and a whole-hour term would
    ///      misprice the flagship product by 3%.
    function termHoursWad() public view returns (uint256) {
        return ((expiryTimestamp - openTimestamp) * Constants.WAD) / 3_600;
    }

    /// @notice The collateral the session still owes on its outstanding claims.
    /// @dev `totalPairSupply` is the liability only while the session is pre-settlement, where every
    ///      pair is worth exactly one unit. Once the payoff is fixed the claims become individually
    ///      redeemable in unequal amounts, so the liability is `L * PI_L + S * PI_S` and a pair
    ///      count is no longer the right quantity. Comparing against `totalPairSupply` after
    ///      settlement would report an insolvent session while it was behaving perfectly, which is
    ///      exactly what the invariant suite caught.
    function liabilityWad() public view returns (uint256) {
        if (state == State.Open || state == State.Expired) {
            return totalPairSupply;
        }
        return WadMath.mulWad(longClaim.totalSupply(), payoffLongWad)
            + WadMath.mulWad(shortClaim.totalSupply(), Constants.WAD - payoffLongWad);
    }

    /// @notice Whether the session can meet its outstanding obligations, and its accrued fees.
    /// @dev Exposed so that a monitoring agent does not have to reimplement the comparison, and so
    ///      that the invariant suite asserts the same predicate the contract advertises rather than
    ///      a re-derivation of it.
    function isCollateralised() external view returns (bool) {
        return collateral.balanceOf(address(this)) >= liabilityWad() + collectedFees;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Checks-effects-interactions, in that textual order. The cap is checked first because a
    ///      cap checked after the write is a cap a re-entrant caller can race; the collateral ledger
    ///      is updated before the pool touches any token for the same reason.
    function _mintPair(address to, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 wouldBe = totalPairSupply + amount;
        if (wouldBe > notionalCapWad) revert NotionalCapExceeded(wouldBe, notionalCapWad);

        totalPairSupply = wouldBe;

        if (!collateral.transferFrom(msg.sender, address(this), amount)) {
            revert ClaimTransferFailed();
        }
        longClaim.mint(to, amount);
        shortClaim.mint(to, amount);
    }

    /// @dev Shared by `buyLong` and `buyShort`, which differ only in the leg the pool delivers.
    function _reserveForMint(uint256 collateralIn, uint256 minOut, bool wantsLong)
        private
        returns (uint256 fromSwap)
    {
        if (collateralIn == 0) revert ZeroAmount();
        uint256 wouldBe = totalPairSupply + collateralIn;
        if (wouldBe > notionalCapWad) revert NotionalCapExceeded(wouldBe, notionalCapWad);

        // The trading fee (Eq 19 scaled by Eq 20) is charged on the deposit and pulled with it.
        // The rate reads the pre-swap pool price, which also reverts on an unseeded pool.
        uint256 feeAmount = WadMath.mulWad(
            collateralIn,
            FeeModel.scaledTradingFeeWad(
                _elapsedHoursWad(), termHoursWad(), _poolPriceLongWad(), pLRefWad
            )
        );

        totalPairSupply = wouldBe;

        if (wantsLong) {
            fromSwap = _acquireLong(msg.sender, collateralIn, feeAmount, minOut);
        } else {
            fromSwap = _acquireShort(msg.sender, collateralIn, feeAmount, minOut);
        }
    }

    /// @dev WAD-scale hours since the reference close, capped at the term so a post-expiry trade (still `Open`, `expire()` not yet called) pays the open fee.
    function _elapsedHoursWad() internal view returns (uint256) {
        uint256 elapsed = ((block.timestamp - openTimestamp) * Constants.WAD) / 3_600;
        uint256 term = termHoursWad();
        return elapsed < term ? elapsed : term;
    }
}
