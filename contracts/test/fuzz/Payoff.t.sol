// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Payoff} from "../../src/libraries/Payoff.sol";

/// @notice The payoff invariants, as fuzz tests over generated inputs (brief §10.3).
/// @dev These are the properties the protocol's solvency rests on. They are asserted over generated
///      inputs rather than examples because an example proves the property at a point and the claim
///      is that it holds on a set.
contract PayoffInvariants is Test {
    /// @dev `PI_L + PI_S == 1` for every reachable `(lambda, G)`. Paper Theorem 1.
    function testFuzz_sumToExactlyOne(uint256 lam, int256 gap) public pure {
        lam = bound(lam, 0, 1000e18);
        gap = bound(gap, -1e18, 1e18);
        assertEq(Payoff.longWad(lam, gap) + Payoff.shortWad(lam, gap), Constants.WAD);
    }

    /// @dev `PI_L` is monotone non-decreasing in `|G|` for every leverage.
    function testFuzz_longIsMonotoneInTheAbsoluteGap(uint256 lam, int256 gapA, int256 gapB)
        public
        pure
    {
        lam = bound(lam, 1e18, 100e18);
        // Bound the gaps before taking an absolute value: `-type(int256).min` is not representable,
        // so an unbounded gap can overflow in the negation rather than exercise the property.
        int256 boundedA = bound(gapA, -1e18, 1e18);
        int256 boundedB = bound(gapB, -1e18, 1e18);
        uint256 magnitudeA = uint256(boundedA < 0 ? -boundedA : boundedA);
        uint256 magnitudeB = uint256(boundedB < 0 ? -boundedB : boundedB);
        if (magnitudeA > magnitudeB) {
            (magnitudeA, magnitudeB) = (magnitudeB, magnitudeA);
        }
        assertGe(
            Payoff.longWad(lam, int256(magnitudeB)),
            Payoff.longWad(lam, int256(magnitudeA)),
            "monotone in |G|"
        );
    }

    /// @dev `PI_L == 1` if and only if `|G| >= 1/lambda`.
    function testFuzz_saturatesExactlyAtTheCap(uint256 lam, int256 gap) public pure {
        lam = bound(lam, 1e18, 1000e18);
        gap = bound(gap, -1e18, 1e18);
        uint256 magnitude = uint256(gap < 0 ? -gap : gap);
        bool atOrBeyondCap = magnitude >= Payoff.saturationGapWad(lam);
        assertEq(Payoff.isSaturated(lam, gap), atOrBeyondCap, "saturation is exactly at the cap");
        if (atOrBeyondCap) {
            assertEq(Payoff.longWad(lam, gap), Constants.WAD, "pays the cap");
        } else {
            assertLt(Payoff.longWad(lam, gap), Constants.WAD, "pays below the cap");
        }
    }

    /// @dev Nobody can ever owe more than they deposited: both legs are in `[0, 1]`. This is the
    ///      property that removes the margin call, the liquidation engine and the liquidation
    ///      cascade from the design.
    function testFuzz_neitherLegCanExceedTheCollateral(uint256 lam, int256 gap) public pure {
        lam = bound(lam, 0, 1000e18);
        gap = bound(gap, -10e18, 10e18);
        assertLe(Payoff.longWad(lam, gap), Constants.WAD, "long is capped");
        assertLe(Payoff.shortWad(lam, gap), Constants.WAD, "short is capped");
    }
}
