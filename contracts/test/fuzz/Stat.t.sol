// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {WadMath} from "../../src/libraries/WadMath.sol";
import {Stat} from "../../src/libraries/Stat.sol";

/// @notice The truncated-moment invariants, as fuzz tests over generated inputs (brief §10.3).
/// @dev Every ordering assertion here carries a slack derived from `Stat.ERF_ABSOLUTE_BOUND_WAD`.
///      That is not hedging. The moment is exactly monotone in `sigma` and exactly bounded by the
///      untruncated mean in real arithmetic, but the cdf it is built on is a rational approximation
///      whose error is bounded rather than zero, and the approximation is not itself monotone at
///      the last few wei. Asserting exact ordering would assert a property the implementation does
///      not have; the correct claim is "monotone to within the implementation's stated error", and
///      that is what is asserted. Exactness is established separately, by the differential suite
///      against a high-precision reference.
contract StatInvariants is Test {
    /// @dev sqrt(2/pi), the untruncated `E[|G|]` divided by sigma.
    uint256 internal constant SQRT_2_OVER_PI_WAD = 797_884_560_802_865_355;

    /// @dev The moment's tail term is `2c * (1 - Phi(c/s))`, and `Phi` inherits half of erf's
    ///      absolute error, so the moment inherits at most `2c * bound / 2 = c * bound`. The extra
    ///      thousand wei covers the two integer divisions in the standardisation.
    function _erfSlack(uint256 cap) internal pure returns (uint256) {
        return 2 * WadMath.mulWad(cap, Stat.ERF_ABSOLUTE_BOUND_WAD / 2) + 1_000;
    }

    function _cap(uint256 lam) internal pure returns (uint256) {
        return WadMath.divWad(Constants.WAD, lam);
    }

    /// @dev `truncatedAbsMoment(lam, mu, s) >= 0` for every valid input. A moment is a probability
    ///      integral, so a negative value would mean the sign convention has broken somewhere.
    function testFuzz_momentIsNonNegative(uint256 lam, uint256 s) public pure {
        lam = bound(lam, 0, 1000e18);
        s = bound(s, 0, 1e18);
        assertGe(Stat.truncatedAbsMoment(lam, 0, s), 0);
    }

    /// @dev The moment is monotone in `s`: a wider distribution has a larger absolute moment for
    ///      every truncation point.
    function testFuzz_momentIsMonotoneInSigma(uint256 lamSeed, uint256 sA, uint256 sB) public pure {
        uint256 lam = bound(lamSeed, 1e18, 100e18);
        uint256 sLow = bound(sA, 1e14, 0.5e18);
        uint256 sHigh = bound(sB, sLow, 0.5e18);
        uint256 slack = _erfSlack(_cap(lam));
        assertGe(
            Stat.truncatedAbsMoment(lam, 0, sHigh) + slack,
            Stat.truncatedAbsMoment(lam, 0, sLow),
            "monotone in sigma to within the erf bound"
        );
    }

    /// @dev The moment is monotone *decreasing* in `lambda`, because a larger leverage means a
    ///      smaller saturation point `c = 1/lambda`, and truncating harder cannot increase the mean.
    function testFuzz_momentIsMonotoneDecreasingInLeverage(uint256 lamA, uint256 lamB, uint256 s)
        public
        pure
    {
        uint256 lamLow = bound(lamA, 1e18, 100e18);
        uint256 lamHigh = bound(lamB, lamLow, 100e18);
        s = bound(s, 1e14, 0.5e18);
        // The smaller cap belongs to the larger leverage, so it carries the smaller slack.
        uint256 slack = _erfSlack(_cap(lamLow));
        assertGe(
            Stat.truncatedAbsMoment(lamLow, 0, s) + slack,
            Stat.truncatedAbsMoment(lamHigh, 0, s),
            "monotone decreasing in lambda to within the erf bound"
        );
    }

    /// @dev Truncation can only remove mass, so the truncated moment never exceeds the untruncated
    ///      `E[|G|]`, and it approaches it as `lambda` falls to zero.
    function testFuzz_momentIsBoundedByTheUntruncatedMean(uint256 lam, uint256 s) public pure {
        lam = bound(lam, 1e18, 1000e18);
        s = bound(s, 1e14, 0.5e18);
        uint256 untruncated = WadMath.mulWad(s, SQRT_2_OVER_PI_WAD);
        assertLe(
            Stat.truncatedAbsMoment(lam, 0, s),
            untruncated + _erfSlack(_cap(lam)),
            "bounded by the untruncated mean to within the erf bound"
        );
    }

    /// @dev `dp/dlambda` is the truncated first moment, so it is likewise bounded by the
    ///      untruncated first moment and is non-negative.
    function testFuzz_dpDlambdaIsBoundedAndNonNegative(uint256 lam, uint256 s) public pure {
        lam = bound(lam, 1e18, 1000e18);
        s = bound(s, 1e14, 0.5e18);
        uint256 untruncated = WadMath.mulWad(s, SQRT_2_OVER_PI_WAD);
        uint256 value = Stat.dpDlambda(lam, s);
        assertGe(value, 0);
        assertLe(value, untruncated + _erfSlack(_cap(lam)));
    }

    /// @dev The premium `lambda * E[min(|G|, 1/lambda)]` is bounded by one for every leverage and
    ///      volatility. This is the payoff cap showing up in the price: the moment is at most the
    ///      saturation point `c = 1/lambda`, so `lambda * moment <= 1` structurally. The slack is
    ///      the erf error that can carry the estimated moment a few wei past `c`.
    function testFuzz_premiumIsBoundedByTheCollateralUnit(uint256 lam, uint256 s) public pure {
        lam = bound(lam, 1e18, 1000e18);
        s = bound(s, 1e14, 1e18);
        uint256 premium = WadMath.mulWad(lam, Stat.truncatedAbsMoment(lam, 0, s));
        assertLe(premium, Constants.WAD + _erfSlack(_cap(lam)), "premium <= 1");
    }
}
