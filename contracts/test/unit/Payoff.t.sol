// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {Payoff} from "../../src/libraries/Payoff.sol";

/// @notice Unit tests for `Payoff`, the capped absolute-move claim.
/// @dev Revert tests route through the `external*` wrappers at the foot of this file.
contract PayoffTest is Test {
    function test_longWad_isCappedAtOne() public pure {
        assertEq(Payoff.longWad(15e18, 0), 0, "no gap, no payoff");
        assertEq(Payoff.longWad(15e18, 0.01e18), 0.15e18, "1% gap at 15x");
        assertEq(Payoff.longWad(15e18, 0.0667e18), 1e18, "at the saturation point");
        assertEq(Payoff.longWad(15e18, 0.2e18), 1e18, "beyond the cap");
        assertEq(Payoff.longWad(15e18, 0.5e18), 1e18, "far beyond the cap");
    }

    function test_longWad_isEvenInTheGap() public pure {
        // The dominant demand is from holders of inventory who are short the gap in both
        // directions, so the direction of a move carries no value -- only its magnitude.
        assertEq(Payoff.longWad(15e18, 0.03e18), Payoff.longWad(15e18, -0.03e18), "even");
        assertEq(Payoff.longWad(11e18, 0.09e18), Payoff.longWad(11e18, -0.09e18), "even");
    }

    function test_shortWad_isTheExactComplement() public pure {
        int256[5] memory gaps = [int256(0), 0.01e18, -0.01e18, 0.0667e18, 0.5e18];
        for (uint256 i = 0; i < gaps.length; ++i) {
            assertEq(
                Payoff.longWad(15e18, gaps[i]) + Payoff.shortWad(15e18, gaps[i]),
                Constants.WAD,
                "sum to one"
            );
        }
    }

    function test_isSaturated_iffTheCapIsReached() public pure {
        assertFalse(Payoff.isSaturated(15e18, 0.0666e18), "just below the cap");
        assertTrue(Payoff.isSaturated(15e18, 0.0667e18), "at the cap");
        assertTrue(Payoff.isSaturated(15e18, -0.5e18), "far beyond, negative");
    }

    function test_saturationGapWad_isTheSmallestSaturatingGap() public pure {
        // Rounded up, so it is the threshold rather than the reciprocal: one wei below it must not
        // saturate. At lambda = 15 the exact value is 66666666666666666.67, so the threshold is
        // ...667.
        assertEq(Payoff.saturationGapWad(15e18), 66666666666666667, "ceil(1/15)");
        assertEq(Payoff.saturationGapWad(1e18), Constants.WAD, "1/1 is exact");
        assertEq(Payoff.saturationGapWad(100e18), 0.01e18, "1/100 is exact");
        assertEq(Payoff.saturationGapWad(32e18), 0.03125e18, "1/32 is exact");
        assertFalse(Payoff.isSaturated(15e18, int256(Payoff.saturationGapWad(15e18) - 1)));
        assertTrue(Payoff.isSaturated(15e18, int256(Payoff.saturationGapWad(15e18))));
    }

    function test_saturationGapWad_revertsOnZeroLeverage() public {
        vm.expectRevert(Payoff.DivByZero.selector);
        this.externalSaturationGapWad(0);
    }

    function test_zeroLeveragePaysNothing() public pure {
        // lambda = 0 is a degenerate listing that the factory's lattice gate must refuse; the payoff
        // function itself is total and returns zero rather than reverting.
        assertEq(Payoff.longWad(0, 0.5e18), 0);
        assertEq(Payoff.shortWad(0, 0.5e18), Constants.WAD);
    }

    // ---------------------------------------------------------------- external wrappers

    function externalSaturationGapWad(uint256 lam) external pure returns (uint256) {
        return Payoff.saturationGapWad(lam);
    }
}
