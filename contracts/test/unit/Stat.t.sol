// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {WadMath} from "../../src/libraries/WadMath.sol";
import {Stat} from "../../src/libraries/Stat.sol";

/// @notice Unit tests for `Stat`, the distributional core.
/// @dev Revert tests route through the `external*` wrappers at the foot of this file: the library
///      functions are `internal`, so a direct call is inlined and creates no frame for
///      `vm.expectRevert` to observe.
contract StatTest is Test {
    /// @dev Thrown when the fixture does not carry a cell the test is looking for. A named error
    ///      rather than a revert string, per the brief's rule that strings in reverts are
    ///      ungreppable.
    error FixtureMissingReferenceCell(string name, string session);

    string internal constant FIXTURE = "../spec/fixtures/canonical.json";

    /// @dev Read once per suite rather than once per test. Besides being cheaper, it removes a
    ///      repeatable-but-intermittent failure in which the second of two concurrent
    ///      `vm.readFile` calls on the same path reverts. See DESIGN_NOTES.md F21.
    string internal fixtureJson;

    function setUp() public {
        fixtureJson = vm.readFile(FIXTURE);
    }

    /// @dev sqrt(2/pi), the c -> infinity limit of the moment divided by sigma.
    uint256 internal constant SQRT_2_OVER_PI_WAD = 797_884_560_802_865_355;

    // ---------------------------------------------------------------- expWad

    function test_expWad_zeroIsOne() public pure {
        assertEq(Stat.expWad(0), int256(Constants.WAD));
    }

    function test_expWad_knownValues() public pure {
        assertApproxEqRel(Stat.expWad(1e18), 2.718281828459045235e18, 1e12, "e");
        assertApproxEqRel(Stat.expWad(-1e18), 0.367879441171442321e18, 1e12, "1/e");
        assertApproxEqRel(Stat.expWad(2e18), 7.389056098930650227e18, 1e12, "e^2");
        assertApproxEqRel(Stat.expWad(-10e18), 0.000045399929762484e18, 1e12, "e^-10");
    }

    function test_expWad_isMonotoneIncreasing() public pure {
        int256 previous = Stat.expWad(-5e18);
        for (int256 x = -4e18; x <= 5e18; x += 0.5e18) {
            int256 current = Stat.expWad(x);
            assertGt(current, previous, "e^x is strictly increasing");
            previous = current;
        }
    }

    function test_expWad_underflowsToExactlyZero() public pure {
        // Below the stated bound e^x is less than one wei, so zero is the correct answer rather
        // than a truncated approximation.
        assertEq(Stat.expWad(-43e18), 0);
        assertEq(Stat.expWad(type(int256).min + 1), 0);
    }

    function test_expWad_revertsAboveTheStatedBound() public {
        vm.expectRevert(
            abi.encodeWithSelector(Stat.ExpOverflow.selector, 94e18, Stat.EXP_OVERFLOW_BOUND)
        );
        this.externalExpWad(94e18);
    }

    function test_expWad_acceptsExactlyTheBound() public pure {
        assertGt(Stat.expWad(Stat.EXP_OVERFLOW_BOUND), 0, "bound is inclusive");
    }

    // ---------------------------------------------------------------- density and cdf

    function test_standardNormalPdf_knownValues() public pure {
        assertApproxEqRel(Stat.standardNormalPdf(0), 398_942_280_401_432_677, 1e12, "phi(0)");
        assertApproxEqRel(Stat.standardNormalPdf(1e18), 241_970_724_519_143_427, 1e12, "phi(1)");
        assertApproxEqRel(Stat.standardNormalPdf(-1e18), 241_970_724_519_143_427, 1e12, "even");
    }

    function test_standardNormalPdf_isEven() public pure {
        for (int256 x = -8e18; x <= 8e18; x += 0.25e18) {
            assertEq(Stat.standardNormalPdf(x), Stat.standardNormalPdf(-x), "phi is even");
        }
    }

    function test_standardNormalPdf_saturatesToZero() public pure {
        assertEq(Stat.standardNormalPdf(9.1e18), 0, "beyond saturation");
        assertEq(Stat.standardNormalPdf(-9.1e18), 0, "beyond saturation, negative");
        assertEq(Stat.standardNormalPdf(50e18), 0, "far tail cannot overflow expWad");
    }

    function test_standardNormalCdf_knownValues() public pure {
        assertApproxEqAbs(Stat.standardNormalCdf(0), 0.5e18, 1e10, "Phi(0)");
        // The error-function approximation's stated 1.5e-7 bound sets the achievable accuracy.
        assertApproxEqAbs(Stat.standardNormalCdf(1.96e18), 0.975002104851779e18, 1e11, "Phi(1.96)");
        assertApproxEqAbs(
            Stat.standardNormalCdf(-1.96e18), 0.024997895148221e18, 1e11, "lower tail"
        );
    }

    function test_standardNormalCdf_isMonotoneAndBounded() public pure {
        uint256 previous = Stat.standardNormalCdf(-8e18);
        for (int256 x = -7.5e18; x <= 8e18; x += 0.25e18) {
            uint256 current = Stat.standardNormalCdf(x);
            assertGe(current, previous, "cdf is non-decreasing");
            assertLe(current, Constants.WAD, "cdf is bounded by one");
            previous = current;
        }
    }

    // ---------------------------------------------------------------- erf

    function test_erf_knownValues() public pure {
        assertEq(Stat.erf(0), 0, "erf(0) is exact");
        // Tolerance is the approximation's own stated bound, not a chosen number. The function
        // carries no tighter claim than this, so asserting tighter would be asserting a property
        // the library does not have.
        assertApproxEqAbs(
            Stat.erf(1e18), 0.842700792949714869e18, Stat.ERF_ABSOLUTE_BOUND_WAD, "erf(1)"
        );
        assertApproxEqAbs(
            Stat.erf(-1e18), -0.842700792949714869e18, Stat.ERF_ABSOLUTE_BOUND_WAD, "erf(-1)"
        );
    }

    function test_erf_isOdd() public pure {
        for (int256 z = 0; z <= 7e18; z += 0.25e18) {
            assertEq(Stat.erf(z), -Stat.erf(-z), "erf is odd");
        }
    }

    function test_erf_saturatesAtOne() public pure {
        assertEq(Stat.erf(7e18), int256(Constants.WAD), "erf saturates at +1");
        assertEq(Stat.erf(-7e18), -int256(Constants.WAD), "erf saturates at -1");
        assertEq(Stat.erf(100e18), int256(Constants.WAD), "far tail cannot overflow expWad");
    }

    // ---------------------------------------------------------------- the pricing primitive

    function test_truncatedAbsMoment_zeroSigmaIsZero() public pure {
        assertEq(Stat.truncatedAbsMoment(15e18, 0, 0), 0);
        assertEq(Stat.truncatedAbsMoment(0, 0, 0), 0);
    }

    function test_truncatedAbsMoment_zeroLeverageIsTheUntruncatedMean() public pure {
        // c -> infinity, so the moment is E[|G|] = sigma * sqrt(2/pi). This is the paper's stated
        // limit, which is what makes the two branches continuous at the boundary.
        uint256 sigma = 0.02e18;
        assertEq(Stat.truncatedAbsMoment(0, 0, sigma), WadMath.mulWad(sigma, SQRT_2_OVER_PI_WAD));
    }

    function test_truncatedAbsMoment_revertsOnNonZeroMean() public {
        vm.expectRevert(abi.encodeWithSelector(Stat.NonZeroMeanUnsupported.selector, 1e18));
        this.externalTruncatedAbsMoment(15e18, 1e18, 0.02e18);
    }

    function test_truncatedAbsMoment_isBelowTheUntruncatedMean() public pure {
        uint256 sigma = 0.02e18;
        uint256 untruncated = WadMath.mulWad(sigma, SQRT_2_OVER_PI_WAD);
        assertLt(Stat.truncatedAbsMoment(15e18, 0, sigma), untruncated, "truncation cannot add");
    }

    /// @dev The load-bearing regression: `lambda * E[min(|G|, 1/lambda)]` must reproduce the paper's
    ///      Gaussian column (Table 18) from the per-name sigma and lambda of Table 13.
    ///
    ///      Tolerance derivation. sigma is published to two decimal places of a percent, i.e. to
    ///      1e-4 absolute, which is a relative uncertainty of `1e-4 / 0.0109 = 0.92%` at the
    ///      smallest sigma in the table and 0.46% at the largest. The moment is very nearly linear
    ///      in sigma over this range, so the propagated relative uncertainty is at most 0.92%. The
    ///      error function contributes 1.5e-7 absolute, which is negligible beside it. The bound
    ///      below is set at 1% -- just above the derived figure, and not chosen to make a test pass.
    function test_truncatedAbsMoment_reproducesThePublishedGaussianColumn() public {
        string memory json = fixtureJson;
        CanonicalCell[] memory cells = abi.decode(vm.parseJson(json, ".cells"), (CanonicalCell[]));
        GaussianReference[] memory references =
            abi.decode(vm.parseJson(json, ".gaussian_pL"), (GaussianReference[]));
        assertEq(cells.length, 9, "the canonical fixture has nine cells");

        for (uint256 i = 0; i < cells.length; ++i) {
            uint256 premium = WadMath.mulWad(
                cells[i].lambdaWad,
                Stat.truncatedAbsMoment(cells[i].lambdaWad, 0, cells[i].sigmaWad)
            );
            uint256 published = _publishedGaussian(references, cells[i].name, cells[i].session);
            assertApproxEqRel(
                premium,
                published,
                1e16,
                string.concat("Gaussian premium: ", cells[i].name, " ", cells[i].session)
            );
        }
    }

    /// @dev The fixture's own `capWad` must be exactly `1 / lambdaWad`, because the calibrator's
    ///      rounding lattice places the cap and then floors the leverage. If the two disagreed, the
    ///      quoted cap and the quoted leverage would describe different contracts.
    function test_fixture_capIsTheReciprocalOfLeverage() public {
        string memory json = fixtureJson;
        CanonicalCell[] memory cells = abi.decode(vm.parseJson(json, ".cells"), (CanonicalCell[]));
        for (uint256 i = 0; i < cells.length; ++i) {
            assertEq(
                WadMath.divWad(Constants.WAD, cells[i].lambdaWad),
                cells[i].capWad,
                "capWad == 1 / lambdaWad"
            );
        }
    }

    // ---------------------------------------------------------------- dp/dlambda

    function test_dpDlambda_isBelowTheUntruncatedFirstMoment() public pure {
        uint256 sigma = 0.02e18;
        uint256 untruncated = WadMath.mulWad(sigma, SQRT_2_OVER_PI_WAD);
        assertLt(Stat.dpDlambda(15e18, sigma), untruncated, "truncation cannot add");
        assertEq(Stat.dpDlambda(0, sigma), untruncated, "c -> infinity recovers the first moment");
    }

    function test_dpDlambda_isZeroAtZeroSigma() public pure {
        assertEq(Stat.dpDlambda(15e18, 0), 0);
    }

    /// @dev The identity that sizes the publisher bond. `dp/dlambda` is the derivative of the fair
    ///      premium in the leverage, so it must equal the central difference of the premium.
    function testFuzz_dpDlambda_matchesTheNumericDerivativeOfThePremium(uint256 lamSeed, uint256 s)
        public
        pure
    {
        uint256 lam = bound(lamSeed, 2e18, 100e18);
        uint256 sigma = bound(s, 1e15, 0.2e18);
        uint256 step = 1e15;

        uint256 upper = WadMath.mulWad(lam + step, Stat.truncatedAbsMoment(lam + step, 0, sigma));
        uint256 lower = WadMath.mulWad(lam - step, Stat.truncatedAbsMoment(lam - step, 0, sigma));
        // Both numerator and denominator are WAD quantities, so the quotient is the dimensionless
        // derivative; scaling by WAD expresses it at WAD scale to match `dpDlambda`.
        uint256 numericDerivative = ((upper - lower) * Constants.WAD) / (2 * step);

        // Second-order central-difference error is O(step^2) relative to the curvature; a 2% band
        // is generous against the 1e-15 step but still far tighter than any wrong formula would be.
        assertApproxEqRel(Stat.dpDlambda(lam, sigma), numericDerivative, 2e16, "dp/dlambda");
    }

    // ---------------------------------------------------------------- helpers

    function _publishedGaussian(
        GaussianReference[] memory references,
        string memory name,
        string memory session
    ) internal pure returns (uint256) {
        // The search and the revert are separated deliberately: a revert inside a loop is a lint
        // finding in its own right, and hoisting it also makes the failure a single check rather
        // than one per iteration.
        uint256 found = type(uint256).max;
        for (uint256 i = 0; i < references.length; ++i) {
            if (
                keccak256(bytes(references[i].name)) == keccak256(bytes(name))
                    && keccak256(bytes(references[i].session)) == keccak256(bytes(session))
            ) {
                found = i;
                break;
            }
        }
        if (found == type(uint256).max) revert FixtureMissingReferenceCell(name, session);
        return references[found].pLWad;
    }

    // ---------------------------------------------------------------- external wrappers

    function externalExpWad(int256 x) external pure returns (int256) {
        return Stat.expWad(x);
    }

    function externalTruncatedAbsMoment(uint256 lam, int256 mu, uint256 s)
        external
        pure
        returns (uint256)
    {
        return Stat.truncatedAbsMoment(lam, mu, s);
    }
}

struct CanonicalCell {
    string name;
    string session;
    uint256 n;
    uint256 sigmaWad;
    uint256 q99Wad;
    uint256 lambdaWad;
    uint256 capWad;
    uint256 pLWad;
}

struct GaussianReference {
    string name;
    string session;
    uint256 pLWad;
}
