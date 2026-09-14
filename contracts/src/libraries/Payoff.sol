// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";
import {WadMath} from "./WadMath.sol";

/// @title Payoff
/// @notice The claim's terminal payoff: a capped absolute-move claim.
/// @dev `PI_L = min(lambda * |G|, 1)` and `PI_S = 1 - PI_L`. Two properties follow and both are
///      invariants the protocol depends on:
///
///      1. Sum-to-one. `PI_L + PI_S == 1` for every outcome, so a pair is worth exactly the
///         collateral backing it at settlement, always.
///      2. No liquidation. The long payoff is capped at 1 and the short payoff floored at 0, so
///         neither side can owe more than it deposited. There is no margin call, no liquidation
///         engine and no liquidation cascade -- paper Theorem 1.
///
///      This is the single most important formula in the codebase: it is the on-chain payoff and
///      the off-chain calibration target, and the two must agree exactly.
///
///      Why this is a library rather than two lines inside `Session`: the brief's §10.3 requires
///      fuzz tests of properties (`PI_L + PI_S == 1`, monotonicity in `|G|`, saturation iff
///      `|G| >= 1/lambda`) that need a callable pure target, and §5.1 requires the domain core to be
///      testable by calling it with literal arguments. `Session` will call this; it will not
///      reimplement it.
library Payoff {
    /// @dev Thrown when the saturation point is requested at zero leverage, where it is undefined.
    error DivByZero();

    /// @notice The long claim's terminal payoff.
    /// @param lamWad leverage at WAD scale.
    /// @param gapWad the signed session gap `G = O/C_prev - 1` at WAD scale.
    /// @return `min(lambda * |G|, 1)`, at WAD scale.
    /// @dev The absolute value is taken because the dominant demand is from holders of inventory who
    ///      are short the gap in both directions, so the direction of a move carries no value --
    ///      only its magnitude. The function is even in `G`, verified at a residual of exactly zero
    ///      over +/-50% for every session type (paper check S1).
    function longWad(uint256 lamWad, int256 gapWad) internal pure returns (uint256) {
        uint256 magnitude = gapWad < 0 ? uint256(-gapWad) : uint256(gapWad);
        return WadMath.min(WadMath.mulWad(lamWad, magnitude), Constants.WAD);
    }

    /// @notice The short claim's terminal payoff, the complement of the long.
    /// @return `1 - min(lambda * |G|, 1)`, at WAD scale.
    /// @dev Derived by subtraction rather than computed independently. A second expression for the
    ///      complement is the classic way sum-to-one stops holding at the last bit.
    function shortWad(uint256 lamWad, int256 gapWad) internal pure returns (uint256) {
        return Constants.WAD - longWad(lamWad, gapWad);
    }

    /// @notice Whether the long claim pays its cap.
    /// @return True iff `|G| >= saturationGapWad(lambda)`.
    /// @dev By construction this fires with probability `alpha`: the leverage rule is
    ///      `lambda* = 1 / Q_(1-alpha)(|G|)`, so `P(lambda* |G| >= 1) = P(|G| >= Q_(1-alpha)) = alpha`.
    ///      Saturation therefore happens by construction rather than by accident.
    ///
    ///      Defined against `saturationGapWad` rather than against `mulWad(lam, |G|) >= WAD`. The
    ///      two are equivalent in real arithmetic and differ by one wei in fixed point whenever
    ///      `lambda` does not divide `1e36`, which is almost always. Anchoring on the gap makes the
    ///      predicate, the payoff and the reported cap agree exactly at the boundary; anchoring on
    ///      the product would leave a one-wei band where the claim reports saturated but pays less
    ///      than the cap.
    function isSaturated(uint256 lamWad, int256 gapWad) internal pure returns (bool) {
        uint256 magnitude = gapWad < 0 ? uint256(-gapWad) : uint256(gapWad);
        return magnitude >= saturationGapWad(lamWad);
    }

    /// @notice The smallest gap at which the long claim pays its cap.
    /// @return `ceil(1 / lambda)` at WAD scale.
    /// @dev The maximum hedgeable gap and the maximum recovery as a fraction of notional. Beyond it
    ///      the holder bears unhedged residual exposure -- which is a performance question rather
    ///      than a solvency one, because the cap is what bounds the liability at the collateral unit.
    ///
    ///      Rounded up, not down, and the direction is load-bearing. This is the *threshold*, so it
    ///      must be the smallest gap that saturates: rounding down would place the threshold one wei
    ///      below the true crossing and make the predicate disagree with the payoff. `ceil(x)` is
    ///      written `(x + d - 1) / d` to avoid importing a ceiling helper for one call.
    function saturationGapWad(uint256 lamWad) internal pure returns (uint256) {
        if (lamWad == 0) revert DivByZero();
        uint256 numerator = Constants.WAD * Constants.WAD;
        return (numerator + lamWad - 1) / lamWad;
    }
}
