// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";
import {WadMath} from "./WadMath.sol";

/// @title Stat
/// @notice The distributional primitives. Pure library; no storage, no events, no reverts except
///         where stated.
/// @dev This is the mathematical core of the protocol and the one place a formula is shared with
///      the calibrator (`calibrator/src/domain/`). `test/differential` asserts the two agree on
///      `spec/fixtures`.
///
///      On the pricing primitive. `truncatedAbsMoment` returns `E[min(|G|, c)]` with `c = 1/lambda`
///      — the paper's Eq (12), and the fair premium is `lambda * truncatedAbsMoment(...)`. The
///      build brief's §2.4 wrote this as `E[|G| ^ (1/lambda)]`, which is a different function and
///      a different number: for NVDA overnight it returns 0.7374 against 0.0150, making the
///      premium 11.06 against a published 0.1740. Ruling R1 in DESIGN_NOTES.md settles it in
///      favour of the paper. The brief's NatSpec is not implemented, deliberately.
library Stat {
    /// @dev Thrown when `expWad` is asked for a value beyond the stated bound.
    error ExpOverflow(int256 x, int256 bound);

    /// @dev Thrown when a zero-mean-only primitive is called with a non-zero mean.
    error NonZeroMeanUnsupported(int256 mu);

    // ---------------------------------------------------------------- named constants
    //
    // Every literal in this library is named. Provenance is stated per constant, per the brief's
    // §8.1 rule that a constant carries the reason it has the value it has.

    /// @dev `WAD` as a signed value. Every routine here works in signed arithmetic because the
    ///      natural arguments are signed (`-x^2/2`, `c/s` compared against a bound), and converting
    ///      the scale once removes a cast from each expression.
    int256 internal constant WAD_I = 1e18;

    /// @dev sqrt(2 * pi) = 2.5066282746310005024157652848110452530069867406099.
    uint256 internal constant SQRT_2PI_WAD = 2_506_628_274_631_000_502;

    /// @dev sqrt(2 / pi) = 0.79788456080286535587989211986876373695171726232987. This is
    ///      `E[|Z|]` for a standard normal, and therefore the `c -> infinity` limit of
    ///      `truncatedAbsMoment / sigma`, which is what makes the `lam == 0` convention below
    ///      continuous with the general branch rather than a special case bolted on.
    uint256 internal constant SQRT_2_OVER_PI_WAD = 797_884_560_802_865_355;

    /// @dev phi(0) = 1 / sqrt(2 * pi) = 0.39894228040143267793994605993438186847585863116493.
    uint256 internal constant PHI_0_WAD = 398_942_280_401_432_677;

    /// @dev sqrt(2) = 1.4142135623730950488016887242096980785696718753769.
    uint256 internal constant SQRT_2_WAD = 1_414_213_562_373_095_048;

    /// @dev Largest argument `expWad` accepts. The repeated-squaring step squares `e^(x/2)` at
    ///      WAD scale, so it needs `e^(x/2) * 1e18 <= sqrt(2^255 - 1)`; that gives `x <= 94.06`.
    ///      The bound is set at 93 rather than at the exact limit so the final product cannot
    ///      reach the overflow edge. Extending the domain needs a 512-bit mulDiv, which no caller
    ///      here requires: the protocol's only exponential is the normal density, whose argument
    ///      is `-x^2/2 <= 0`.
    int256 internal constant EXP_OVERFLOW_BOUND = 93e18;

    /// @dev Below this `e^x < 1 wei` at WAD scale (ln(1e-18) = -41.45), so the result is exactly
    ///      zero rather than a value that would truncate to zero anyway.
    int256 internal constant EXP_UNDERFLOW_BOUND = -42e18;

    /// @dev Taylor argument reduction: `x` is divided by 2^12 before the series and the result is
    ///      squared 12 times. At `|x| <= 93` the reduced argument is at most 0.0227, where a
    ///      12-term series truncates below 1e-31 relative; the dominant error is the WAD rounding
    ///      of each step, amplified by 2^12, giving about 1e-14 relative overall.
    int256 internal constant EXP_REDUCTION_FACTOR = 4_096;
    uint256 internal constant EXP_SQUARINGS = 12;
    uint256 internal constant EXP_TAYLOR_TERMS = 12;

    /// @dev Beyond `|z| = 7`, `erf(z)` differs from 1 by 2.6e-22, which truncates to exactly 1 at
    ///      WAD scale. Returning early also keeps the `-z^2` argument inside `expWad`'s domain.
    uint256 internal constant ERF_SATURATION_WAD = 7e18;

    /// @dev The stated maximum absolute error of approximation 7.1.26: 1.5e-7, at WAD scale.
    ///      Exposed because it is the tolerance every downstream accuracy claim is derived from --
    ///      `standardNormalCdf`, `truncatedAbsMoment` and the differential suite all inherit it, and
    ///      a test that hard-codes its own copy of this number is a second source of truth.
    uint256 internal constant ERF_ABSOLUTE_BOUND_WAD = 150_000_000_000;

    /// @dev Beyond `|x| = 9.1`, `phi(x)` is below 1 wei at WAD scale (the crossing is at 9.003),
    ///      so the density is exactly zero. The margin also keeps `-x^2/2` inside `expWad`'s
    ///      domain for every reachable input.
    uint256 internal constant PHI_SATURATION_WAD = 9.1e18;

    // Abramowitz & Stegun, Handbook of Mathematical Functions (1964), approximation 7.1.26 --
    // the same reference the paper cites (its ref 19) for the on-chain terminal branch.
    // Stated maximum absolute error: 1.5e-7, i.e. 1.5e11 wei at WAD scale.
    int256 internal constant ERF_P_WAD = 327_591_100_000_000_000;
    int256 internal constant ERF_A1_WAD = 254_829_592_000_000_000;
    int256 internal constant ERF_A2_WAD = -284_496_736_000_000_000;
    int256 internal constant ERF_A3_WAD = 1_421_413_741_000_000_000;
    int256 internal constant ERF_A4_WAD = -1_453_152_027_000_000_000;
    int256 internal constant ERF_A5_WAD = 1_061_405_429_000_000_000;

    // ---------------------------------------------------------------- primitives

    /// @notice `|x|`.
    /// @dev `-type(int256).min` is not representable, so the most negative input is out of domain.
    ///      No caller in this repository can reach it: every signed value here is bounded by a
    ///      WAD-scale quantity.
    function abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }

    /// @notice `e^x` at WAD scale.
    /// @param x exponent at WAD scale; reverts above `EXP_OVERFLOW_BOUND`.
    /// @return r `e^x * 1e18`, truncated toward zero, or exactly 0 below `EXP_UNDERFLOW_BOUND`.
    /// @dev Range-reduce by 2^12, expand a 12-term Taylor series on the small argument, then square
    ///      12 times. Chosen over a rational (Pade) approximation because the series is short, has
    ///      no division, and its truncation error is provably negligible on the reduced domain --
    ///      see `EXP_REDUCTION_FACTOR`. The revert is a fault, not a designed degradation: no
    ///      protocol path can supply an argument above the bound.
    function expWad(int256 x) internal pure returns (int256) {
        if (x > EXP_OVERFLOW_BOUND) revert ExpOverflow(x, EXP_OVERFLOW_BOUND);
        if (x < EXP_UNDERFLOW_BOUND) return 0;

        int256 reduced = x / EXP_REDUCTION_FACTOR;
        int256 term = reduced;
        int256 acc = WAD_I + reduced;
        for (uint256 n = 2; n <= EXP_TAYLOR_TERMS; ++n) {
            int256 divisor = WAD_I * int256(n);
            // False positive: the numerator is multiplied before the division. The linter's
            // heuristic trips on `divisor` being a product, not on the order of operations.
            // forge-lint: disable-next-line(divide-before-multiply)
            term = (term * reduced) / divisor;
            acc += term;
        }
        for (uint256 i = 0; i < EXP_SQUARINGS; ++i) {
            acc = (acc * acc) / WAD_I;
        }
        return acc;
    }

    /// @notice The standard normal probability density, `phi(x)`.
    /// @param x argument at WAD scale.
    /// @return `phi(x) * 1e18`, in [0, PHI_0_WAD]. Exactly 0 beyond `PHI_SATURATION_WAD`.
    /// @dev `phi(x) = exp(-x^2/2) / sqrt(2*pi)`. The saturation guard is not only an optimisation:
    ///      it is what keeps `-x^2/2` inside `expWad`'s domain, and the paper's own check X9 found
    ///      an `expWad` overflow in exactly this call site.
    function standardNormalPdf(int256 x) internal pure returns (uint256) {
        uint256 magnitude = abs(x);
        if (magnitude >= PHI_SATURATION_WAD) return 0;
        uint256 halfSquare = WadMath.mulWad(magnitude, magnitude) / 2;
        int256 density = expWad(-int256(halfSquare));
        return (uint256(density) * Constants.WAD) / SQRT_2PI_WAD;
    }

    /// @notice The standard normal cumulative distribution, `Phi(x)`.
    /// @param x argument at WAD scale.
    /// @return `Phi(x) * 1e18`, in [0, WAD].
    /// @dev `Phi(x) = (1 + erf(x / sqrt(2))) / 2`. Named `standardNormalCdf` rather than `Phi`
    ///      because the brief's §7.2 requires camelCase for functions and a capitalised `Phi` fails
    ///      the linter; the paper's notation is kept in this NatSpec. The error function's 1.5e-7
    ///      absolute bound dominates this result, so the cdf is accurate to about 1e-7 -- two
    ///      orders coarser than the density. That asymmetry is real and is why
    ///      `truncatedAbsMoment`'s accuracy is quoted against the error-function bound rather than
    ///      against WAD precision.
    function standardNormalCdf(int256 x) internal pure returns (uint256) {
        int256 standardised = (x * WAD_I) / int256(SQRT_2_WAD);
        int256 cumulative = erf(standardised);
        return uint256((WAD_I + cumulative) / 2);
    }

    /// @notice The error function `erf(z)`.
    /// @param z argument at WAD scale.
    /// @return erf(z) * 1e18, in [-WAD, WAD].
    /// @dev Abramowitz & Stegun 7.1.26: `erf(z) = 1 - (a1 t + ... + a5 t^5) e^(-z^2)` with
    ///      `t = 1/(1 + p|z|)`, odd-symmetrised in `z`. Stated maximum absolute error 1.5e-7
    ///      (1.5e11 wei). A rational approximation with a stated bound is used rather than a
    ///      truncated Taylor series, which has no useful bound over this range.
    ///
    ///      The origin is returned exactly rather than as the approximation's 1e-9 residual. That
    ///      residual is inside the stated bound, but it is the one point where the odd symmetry has
    ///      no cancellation to absorb it, and `erf(0) == 0` is a property callers may rely on.
    function erf(int256 z) internal pure returns (int256) {
        bool isNegative = z < 0;
        uint256 magnitude = isNegative ? uint256(-z) : uint256(z);
        if (magnitude == 0) return 0;
        if (magnitude >= ERF_SATURATION_WAD) {
            return isNegative ? -WAD_I : WAD_I;
        }

        uint256 t = WadMath.divWad(
            Constants.WAD, Constants.WAD + WadMath.mulWad(uint256(ERF_P_WAD), magnitude)
        );
        int256 polynomial = _erfPolynomial(t);
        int256 decay = expWad(-int256(WadMath.mulWad(magnitude, magnitude)));
        int256 magnitudeResult = WAD_I - (polynomial * decay) / WAD_I;
        return isNegative ? -magnitudeResult : magnitudeResult;
    }

    /// @dev Horner evaluation of `a1 t + a2 t^2 + ... + a5 t^5`, most significant first.
    function _erfPolynomial(uint256 t) private pure returns (int256) {
        int256 s = int256(t);
        int256 accumulator = ERF_A5_WAD;
        accumulator = (accumulator * s) / WAD_I + ERF_A4_WAD;
        accumulator = (accumulator * s) / WAD_I + ERF_A3_WAD;
        accumulator = (accumulator * s) / WAD_I + ERF_A2_WAD;
        accumulator = (accumulator * s) / WAD_I + ERF_A1_WAD;
        return (accumulator * s) / WAD_I;
    }

    // ---------------------------------------------------------------- the pricing primitive

    /// @notice `E[ min(|G|, c) ]` for `G ~ N(mu, s^2)`, with `c = 1 / lam`.
    /// @param lam leverage at WAD scale; `0` means no truncation.
    /// @param mu mean of the gap at WAD scale. Must be zero -- see the `@dev`.
    /// @param s standard deviation of the gap at WAD scale.
    /// @return The truncated absolute moment at WAD scale. The fair long premium is
    ///         `lam * this` (paper §5.1).
    /// @dev Paper Eq (12): `2s(phi(0) - phi(c/s)) + 2c(1 - Phi(c/s))`. Split at `|G| = c`; the
    ///      inner integral is `-phi`, the outer term is `c * P(|G| >= c)`.
    ///
    ///      Conventions, stated rather than implied:
    ///      - `s == 0`: `G` is identically zero, so the moment is zero.
    ///      - `lam == 0`: `c` is infinite and the moment is the untruncated `E[|G|] = s * sqrt(2/pi)`.
    ///        This is the paper's stated `c -> infinity` limit, so the two branches are continuous
    ///        at the boundary rather than discontinuous. Neither branch divides by zero.
    ///
    ///      A non-zero mean is refused rather than approximated. `|G|` is then folded normal and
    ///      the truncated moment has no closed form, so an on-chain implementation would need
    ///      quadrature -- measured at 685,590 gas for 32 terms against 2,640 for a storage read,
    ///      which is the entire reason the fit lives off-chain (paper §7.11). The protocol's model
    ///      is `G ~ N(0, sigma^2)`; `mu` is carried for interface compatibility and must be zero.
    function truncatedAbsMoment(uint256 lam, int256 mu, uint256 s) internal pure returns (uint256) {
        if (mu != 0) revert NonZeroMeanUnsupported(mu);
        if (s == 0) return 0;
        if (lam == 0) return WadMath.mulWad(s, SQRT_2_OVER_PI_WAD);
        return truncatedAbsMomentAtCap(WadMath.divWad(Constants.WAD, lam), s);
    }

    /// @notice `E[ min(|G|, c) ]` for `G ~ N(0, s^2)`, given the cap directly.
    /// @param c saturation point at WAD scale.
    /// @param s standard deviation at WAD scale; must be non-zero.
    /// @dev Split out because the calibrator's empirical route works in cap space (the rounding
    ///      lattice places `c`, then `lambda = floor(1/c)`), so a caller that already holds `c`
    ///      should not round-trip through `lam` and lose the lattice position.
    function truncatedAbsMomentAtCap(uint256 c, uint256 s) internal pure returns (uint256) {
        uint256 standardised = WadMath.divWad(c, s);
        uint256 body = 2 * WadMath.mulWad(s, PHI_0_WAD - standardNormalPdf(int256(standardised)));
        uint256 tail =
            2 * WadMath.mulWad(c, Constants.WAD - standardNormalCdf(int256(standardised)));
        return body + tail;
    }

    /// @notice `dp/dlambda = E[ |G| * 1{ |G| <= 1/lambda } ]` for `G ~ N(0, s^2)`.
    /// @param lam leverage at WAD scale; `0` means no truncation.
    /// @param s standard deviation at WAD scale.
    /// @return The truncated first absolute moment at WAD scale.
    /// @dev The derivative of the fair premium in the leverage, and therefore the value of one
    ///      lattice step of leverage error per unit of notional. This is the identity that sizes
    ///      the publisher bond (paper §7.11, Table 19): at NVDA's overnight parameters it is
    ///      1.1119% of notional, which on $8.53M of committed depth is $94,849, and three times
    ///      that rounds up to the $500,000 bond.
    ///
    ///      It is a named function rather than an inlined expression because it is load-bearing in
    ///      two places at once -- the bond derivation and the differential suite -- and a duplicated
    ///      formula across languages is guaranteed to diverge.
    function dpDlambda(uint256 lam, uint256 s) internal pure returns (uint256) {
        if (s == 0) return 0;
        if (lam == 0) return WadMath.mulWad(s, SQRT_2_OVER_PI_WAD);
        uint256 standardised = WadMath.divWad(WadMath.divWad(Constants.WAD, lam), s);
        return 2 * WadMath.mulWad(s, PHI_0_WAD - standardNormalPdf(int256(standardised)));
    }
}
