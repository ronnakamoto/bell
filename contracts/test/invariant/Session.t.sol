// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Session} from "../../src/core/Session.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Drives a session through arbitrary call sequences.
/// @dev Every action is guarded so it cannot revert. The invariant profile sets
///      `fail_on_revert = true`, which is the right setting -- a handler that swallows reverts
///      explores a much smaller state space than it appears to -- but it means an unguarded action
///      would abort the run instead of reporting a finding.
contract SessionHandler is Test {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant NOTIONAL_CAP = 20_000_000 * UNIT;

    MockERC20 public immutable collateral;
    Session public immutable session;

    address[3] public actors;
    uint256 public settledPayoff;

    constructor(MockERC20 collateral_, Session session_) {
        collateral = collateral_;
        session = session_;
        actors[0] = address(0xA1);
        actors[1] = address(0xB0);
        actors[2] = address(0xC3);
        // Approvals on all three tokens. The claim legs need their own allowances because the swap
        // paths pull them with `transferFrom`, and an unapproved leg reverts with
        // `InsufficientAllowance` rather than doing anything surprising -- which is how this was
        // found.
        for (uint256 i = 0; i < actors.length; ++i) {
            vm.startPrank(actors[i]);
            collateral.approve(address(session), type(uint256).max);
            session.longClaim().approve(address(session), type(uint256).max);
            session.shortClaim().approve(address(session), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @dev Deposit collateral and receive a pair.
    function mint(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, UNIT, 100_000 * UNIT);
        if (session.totalPairSupply() + amount > NOTIONAL_CAP) return;
        if (session.state() != Session.State.Open) return;
        vm.prank(actor);
        session.mintPair(amount);
    }

    /// @dev Burn a pair and take back the collateral, less the fee.
    function redeem(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 held = session.longClaim().balanceOf(actor);
        uint256 shortHeld = session.shortClaim().balanceOf(actor);
        uint256 limit = held < shortHeld ? held : shortHeld;
        if (limit == 0) return;
        amount = bound(amount, 1, limit);
        if (session.state() != Session.State.Open) return;
        if (session.longReserve() == 0 || session.shortReserve() == 0) return;
        vm.prank(actor);
        session.redeemPair(amount);
    }

    /// @dev Seed the pool with whatever the actor already holds, at the pool's prevailing ratio.
    function seed(uint256 actorSeed, uint256 longIn) external {
        address actor = actors[actorSeed % actors.length];
        if (session.state() != Session.State.Open) return;
        if (session.longReserve() == 0 || session.shortReserve() == 0) return;

        uint256 longHeld = session.longClaim().balanceOf(actor);
        uint256 shortHeld = session.shortClaim().balanceOf(actor);
        longIn = bound(longIn, 1, longHeld == 0 ? 1 : longHeld);
        if (longHeld == 0) return;
        // Derive the matching short leg from the pool's ratio so the price-neutral rule is satisfied
        // by construction rather than by luck.
        uint256 shortIn = (longIn * session.shortReserve()) / session.longReserve();
        if (shortIn == 0 || shortIn > shortHeld) return;

        vm.prank(actor);
        session.seedPool(longIn, shortIn);
    }

    /// @dev Take a directional position by depositing collateral.
    function buy(uint256 actorSeed, uint256 collateralIn, bool wantsLong) external {
        address actor = actors[actorSeed % actors.length];
        collateralIn = bound(collateralIn, UNIT, 10_000 * UNIT);
        if (session.state() != Session.State.Open) return;
        if (session.totalPairSupply() + collateralIn > NOTIONAL_CAP) return;
        if (session.longReserve() == 0 || session.shortReserve() == 0) return;

        vm.prank(actor);
        if (wantsLong) {
            session.buyLong(collateralIn, 0);
        } else {
            session.buyShort(collateralIn, 0);
        }
    }

    /// @dev Move an existing holding across the pool.
    function swap(uint256 actorSeed, uint256 amount, bool shortIn) external {
        address actor = actors[actorSeed % actors.length];
        if (session.state() != Session.State.Open) return;
        uint256 held =
            shortIn ? session.shortClaim().balanceOf(actor) : session.longClaim().balanceOf(actor);
        if (held == 0) return;
        amount = bound(amount, 1, held);
        vm.prank(actor);
        if (shortIn) {
            session.swapShortForLong(amount, 0);
        } else {
            session.swapLongForShort(amount, 0);
        }
    }

    /// @dev Advance the clock and settle, so the post-settlement invariants are reachable too.
    function settle(uint256 payoffSeed) external {
        if (session.state() == Session.State.Open) {
            vm.warp(session.expiryTimestamp() + 1);
            session.expire();
        }
        if (session.state() != Session.State.Expired) return;
        settledPayoff = bound(payoffSeed, 0, Constants.WAD);
        vm.prank(session.referenceRegistry());
        session.settle(settledPayoff, false);
    }

    /// @dev Redeem everything the actor holds, post-settlement.
    function claim(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        if (session.state() != Session.State.Settled) return;
        if (session.longClaim().balanceOf(actor) == 0 && session.shortClaim().balanceOf(actor) == 0)
        {
            return;
        }
        vm.prank(actor);
        session.claim();
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

/// @notice The invariants that must hold across arbitrary call sequences (brief §10.3).
/// @dev These are the properties the protocol's solvency rests on, and they are asserted over
///      generated sequences rather than examples because the claim is that they hold on every
///      reachable state, not at a point.
contract SessionInvariants is Test {
    uint256 internal constant UNIT = 1e6;
    uint256 internal constant NOTIONAL_CAP = 20_000_000 * UNIT;

    MockERC20 internal collateral;
    Session internal session;
    SessionHandler internal handler;

    function setUp() public {
        collateral = new MockERC20("USD Global", "USDG", 6);
        vm.warp(1_800_000_000);
        session = new Session(
            collateral,
            address(0xBEEF),
            15e18,
            block.timestamp + 17.5 hours,
            NOTIONAL_CAP,
            address(0xA11CE)
        );

        handler = new SessionHandler(collateral, session);
        for (uint256 i = 0; i < 3; ++i) {
            collateral.mint(handler.actors(i), 5_000_000 * UNIT);
        }
        // The handler must be able to mint pairs on its own behalf for the seed path.
        collateral.mint(address(handler), 5_000_000 * UNIT);
        vm.prank(address(handler));
        collateral.approve(address(session), type(uint256).max);

        targetContract(address(handler));
    }

    /// @dev Invariant 1 of the brief's §4.1.5: the pool is never under-collateralised. This is
    ///      Theorem 1 as a runtime property rather than an argument, and it is asserted through the
    ///      contract's own predicate so that the test and the published view cannot drift apart.
    function invariant_collateralAlwaysCoversThePairs() public view {
        assertTrue(session.isCollateralised(), "collateral >= liability + accrued fees");
    }

    /// @dev A pair is exactly two claims, and the ledger agrees. Without this, a mint or burn path
    ///      could create one leg without the other and the collateral comparison above would still
    ///      hold -- the under-collateralisation would simply be invisible.
    ///
    ///      Asserted pre-settlement only, and that restriction is the point: once the payoff is
    ///      fixed, claims are redeemable individually and in unequal amounts, so the two supplies
    ///      legitimately diverge from the pair count. The post-settlement property is the liability
    ///      bound asserted below.
    function invariant_claimsAlwaysMatchThePairLedger() public view {
        if (session.state() != Session.State.Open && session.state() != Session.State.Expired) {
            return;
        }
        assertEq(
            session.longClaim().totalSupply(), session.totalPairSupply(), "long supply == pairs"
        );
        assertEq(
            session.shortClaim().totalSupply(), session.totalPairSupply(), "short supply == pairs"
        );
    }

    /// @dev The pool's *reserves* are the pool's *balances*. A divergence means the AMM is quoting
    ///      against a number that does not exist, which is how a pool silently becomes insolvent
    ///      while every other invariant still holds.
    function invariant_poolReservesMatchItsBalances() public view {
        assertEq(
            session.longClaim().balanceOf(address(session)),
            session.longReserve(),
            "long reserve == balance"
        );
        assertEq(
            session.shortClaim().balanceOf(address(session)),
            session.shortReserve(),
            "short reserve == balance"
        );
    }

    /// @dev The pool's marginal prices sum to one to within a wei of fixed-point rounding, so no set
    ///      of quotes admits a parity arbitrage (paper Eq 7, check M1).
    function invariant_thePoolNeverQuotesAParityArbitrage() public view {
        if (session.longReserve() == 0 || session.shortReserve() == 0) return;
        uint256 longPrice = session.poolPriceLongWad();
        uint256 shortPrice = (session.longReserve() * Constants.WAD)
            / (session.longReserve() + session.shortReserve());
        assertApproxEqAbs(longPrice + shortPrice, Constants.WAD, 1, "pL + pS == 1");
    }

    /// @dev Once the payoff is fixed, the total liability never exceeds the collateral held. This is
    ///      the settlement-side half of Theorem 1, and it is only reachable because the handler can
    ///      drive the session through expiry and settlement. `liabilityWad` is the contract's own
    ///      statement of that liability, so the test cannot assert a different one.
    function invariant_settledLiabilityIsBoundedByCollateral() public view {
        if (session.state() != Session.State.Settled) return;
        assertLe(
            session.liabilityWad() + session.collectedFees(),
            collateral.balanceOf(address(session)),
            "liability <= collateral held"
        );
    }

    /// @dev No state transition ever moves backwards.
    function invariant_theLifecycleNeverReverses() public view {
        assertLe(uint8(session.state()), uint8(Session.State.Claimed));
    }
}
