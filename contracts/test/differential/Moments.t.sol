// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {WadMath} from "../../src/libraries/WadMath.sol";
import {Stat} from "../../src/libraries/Stat.sol";

/// @notice The pricing primitive, checked against a high-precision reference.
/// @dev This is the differential test the brief's §10.4 calls critical. The reference values in
///      `spec/fixtures/moments.json` are computed at 50 significant digits -- by
///      `bell_calibrator.domain.moments` when the file was first rendered, and by
///      `calibrator/src/domain/moments.ts` since the port, the two having been checked
///      byte-for-byte against each other. This contract computes the same quantity with Abramowitz &
///      Stegun 7.1.26 and asserts the two agree inside the tolerance the fixture records.
///
///      The tolerance is not chosen here. It is derived from the on-chain error function's stated
///      1.5e-7 absolute bound, and the derivation lives in `tools/gen_moments_fixture.ts` where the
///      reference is produced, so that neither consumer re-derives it and the two cannot drift.
contract MomentsDifferentialTest is Test {
    string internal constant FIXTURE = "../spec/fixtures/moments.json";

    /// @dev Headroom for the integer divisions and the final multiplication in `mulWad`, which are
    ///      not part of the error-function bound the fixture's tolerance is derived from.
    uint256 internal constant WAD_ROUNDING_SLACK = 1_000;

    /// @dev The tolerance is the derived bound, so the only assertion available is "inside it". The
    ///      observed utilisation is logged rather than asserted against an invented ceiling, because
    ///      the honest number is high: Abramowitz & Stegun 7.1.26 nearly attains its stated 1.5e-7
    ///      absolute error, and the moment consumes about 92% of the derived tolerance at its worst
    ///      point. That leaves roughly 8% of headroom, which is worth knowing before anyone tightens
    ///      the reference or coarsens the approximation. It is recorded in DESIGN_NOTES.md.
    function test_truncatedMomentAgreesWithThePythonReference() public {
        string memory json = vm.readFile(FIXTURE);
        uint256 pointCount = vm.parseJsonUint(json, ".pointCount");
        assertGt(pointCount, 0, "the fixture carries at least one point");

        uint256 worstPercentOfTolerance = 0;
        uint256 worstPointIndex = 0;
        for (uint256 i = 0; i < pointCount; ++i) {
            string memory base = string.concat(".points[", vm.toString(i), "]");
            uint256 lam = vm.parseJsonUint(json, string.concat(base, ".lambdaWad"));
            uint256 sigma = vm.parseJsonUint(json, string.concat(base, ".sigmaWad"));
            uint256 expected = vm.parseJsonUint(json, string.concat(base, ".momentWad"));
            uint256 tolerance = vm.parseJsonUint(json, string.concat(base, ".toleranceWei"));

            uint256 computed = Stat.truncatedAbsMoment(lam, 0, sigma);
            uint256 delta = computed > expected ? computed - expected : expected - computed;
            assertLe(
                delta,
                tolerance,
                string.concat("moment outside tolerance at point ", vm.toString(i))
            );

            uint256 percent = (delta * 100) / tolerance;
            if (percent > worstPercentOfTolerance) {
                worstPercentOfTolerance = percent;
                worstPointIndex = i;
            }
        }
        emit log_named_uint(
            "worst utilisation of the derived tolerance, percent", worstPercentOfTolerance
        );
        emit log_named_uint("at fixture point", worstPointIndex);
        assertLe(worstPercentOfTolerance, 100, "inside the derived bound");
    }

    /// @dev The premium is `lambda * moment`, so it inherits the moment's error scaled by lambda.
    ///      Checked separately because it is the quantity the registry actually publishes, and a
    ///      scaling bug would be invisible in a moment-only test at lambda = 1.
    function test_premiumAgreesWithThePythonReference() public view {
        string memory json = vm.readFile(FIXTURE);
        uint256 pointCount = vm.parseJsonUint(json, ".pointCount");
        for (uint256 i = 0; i < pointCount; ++i) {
            string memory base = string.concat(".points[", vm.toString(i), "]");
            uint256 lam = vm.parseJsonUint(json, string.concat(base, ".lambdaWad"));
            uint256 sigma = vm.parseJsonUint(json, string.concat(base, ".sigmaWad"));
            uint256 expected = vm.parseJsonUint(json, string.concat(base, ".premiumWad"));
            uint256 tolerance = vm.parseJsonUint(json, string.concat(base, ".toleranceWei"));

            uint256 computed = WadMath.mulWad(lam, Stat.truncatedAbsMoment(lam, 0, sigma));
            uint256 scaledTolerance = WadMath.mulWad(lam, tolerance) + WAD_ROUNDING_SLACK;
            uint256 delta = computed > expected ? computed - expected : expected - computed;
            assertLe(
                delta,
                scaledTolerance,
                string.concat("premium outside tolerance at point ", vm.toString(i))
            );
        }
    }

    /// @dev `dp/dlambda` is the other load-bearing identity, and it is what sizes the publisher
    ///      bond. Checked against the same reference.
    function test_truncatedFirstMomentAgreesWithThePythonReference() public view {
        string memory json = vm.readFile(FIXTURE);
        uint256 pointCount = vm.parseJsonUint(json, ".pointCount");
        for (uint256 i = 0; i < pointCount; ++i) {
            string memory base = string.concat(".points[", vm.toString(i), "]");
            uint256 lam = vm.parseJsonUint(json, string.concat(base, ".lambdaWad"));
            uint256 sigma = vm.parseJsonUint(json, string.concat(base, ".sigmaWad"));
            uint256 expected = vm.parseJsonUint(json, string.concat(base, ".firstMomentWad"));
            uint256 tolerance = vm.parseJsonUint(json, string.concat(base, ".toleranceWei"));

            uint256 computed = Stat.dpDlambda(lam, sigma);
            uint256 delta = computed > expected ? computed - expected : expected - computed;
            assertLe(
                delta,
                tolerance,
                string.concat("first moment outside tolerance at point ", vm.toString(i))
            );
        }
    }
}
