// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/generated/Constants.sol";
import {FeeModel} from "../../src/libraries/FeeModel.sol";

/// @notice Unit tests for `FeeModel`.
/// @dev Revert tests route through the `external*` wrappers at the foot of this file.
contract FeeModelTest is Test {
    /// @dev Session terms from the paper's Table 4. WAD-scale hours, because 17.5 and 65.5 are not
    ///      integers and a whole-hour parameter would misprice the flagship session by 3%.
    uint256 internal constant OVERNIGHT_HOURS = 17.5e18;
    uint256 internal constant WEEKEND_HOURS = 65.5e18;
    uint256 internal constant HOLIDAY_HOURS = 89.5e18;

    /// @dev The paper's Table 4 figures, in basis points at WAD scale.
    uint256 internal constant OVERNIGHT_BP = 2.397e14;
    uint256 internal constant WEEKEND_BP = 8.97e14;
    uint256 internal constant HOLIDAY_BP = 12.26e14;

    // ---------------------------------------------------------------- Eq (17)

    /// @dev The defect Eq (17) repairs is not the magnitude of a flat fee but that a flat fee prices
    ///      time at a rate that varies by a factor of forty depending on the product. The annualised
    ///      specification gives the same implied annual rate on every term by construction.
    ///
    ///      Tolerance: `assertApproxEqRel` takes its tolerance in WAD, so 1e15 is one part per
    ///      thousand. The published figures are 2.397 / 8.97 / 12.26 basis points -- three to four
    ///      significant figures -- so the coarsest of them carries a 5e-4 rounding uncertainty and
    ///      one part per thousand is the derived bound.
    function test_protocolFeeUncapped_matchesThePublishedSessionTable() public pure {
        assertApproxEqRel(FeeModel.protocolFeeUncappedWad(OVERNIGHT_HOURS), OVERNIGHT_BP, 1e15, "E");
        assertApproxEqRel(FeeModel.protocolFeeUncappedWad(WEEKEND_HOURS), WEEKEND_BP, 1e15, "W");
        assertApproxEqRel(FeeModel.protocolFeeUncappedWad(HOLIDAY_HOURS), HOLIDAY_BP, 1e15, "H");
    }

    function test_protocolFeeUncapped_annualisesToTwelvePercentOnEveryTerm() public pure {
        // Re-annualising each fee must return 12%, which is the whole point of specifying a rate.
        uint256[3] memory terms = [OVERNIGHT_HOURS, WEEKEND_HOURS, HOLIDAY_HOURS];
        for (uint256 i = 0; i < terms.length; ++i) {
            uint256 fee = FeeModel.protocolFeeUncappedWad(terms[i]);
            uint256 annualised = (fee * Constants.HOURS_PER_YEAR * Constants.WAD) / terms[i];
            assertApproxEqRel(
                annualised, Constants.PROTOCOL_FEE_ANNUALISED_WAD, 1e6, "implied annual rate"
            );
        }
    }

    function test_protocolFeeUncapped_revertsOnZeroTerm() public {
        vm.expectRevert(FeeModel.TermZero.selector);
        this.externalProtocolFeeUncappedWad(0);
    }

    // ---------------------------------------------------------------- Eq (18)

    /// @dev At a premium of 0.228 the guardrail permits 114 bp against a 9.0 bp charge, so it does
    ///      not bind in normal conditions and binds only under stress (check P12).
    function test_protocolFeeCap_permitsOneHundredAndFourteenBasisPoints() public pure {
        assertEq(FeeModel.protocolFeeCapWad(0.228e18), 1.14e16, "0.05 * 0.228");
        assertFalse(FeeModel.protocolFeeIsCapped(0.228e18, WEEKEND_HOURS), "does not bind");
    }

    function test_protocolFeeIsCapped_bindsWhenThePremiumCompresses() public pure {
        // A collapsed premium with the same term: the cap, not the term, becomes binding.
        assertTrue(FeeModel.protocolFeeIsCapped(0.001e18, HOLIDAY_HOURS), "cap binds");
    }

    function test_protocolFee_neverExceedsItsOwnGuardrail() public pure {
        // The brief's §4.1.8 requirement: a fee function that can silently exceed its own guardrail
        // is worse than no guardrail. Asserted here as an example, and by fuzz below.
        assertLe(
            FeeModel.protocolFeeWad(0.228e18, HOLIDAY_HOURS),
            FeeModel.protocolFeeCapWad(0.228e18),
            "capped"
        );
    }

    function testFuzz_protocolFee_neverExceedsThePremiumCap(uint256 pL, uint256 termHoursWad)
        public
        pure
    {
        pL = bound(pL, 0, 1e18);
        termHoursWad = bound(termHoursWad, 1, 200e18);
        assertLe(
            FeeModel.protocolFeeWad(pL, termHoursWad),
            FeeModel.protocolFeeCapWad(pL),
            "the cap is never exceeded"
        );
        assertLe(
            FeeModel.protocolFeeWad(pL, termHoursWad),
            FeeModel.protocolFeeUncappedWad(termHoursWad),
            "the term proration is never exceeded"
        );
    }

    // ---------------------------------------------------------------- Eq (19)

    function test_tradingFee_rampsFromPhi0ToPhi1() public pure {
        assertEq(
            FeeModel.tradingFeeWad(0, OVERNIGHT_HOURS), Constants.RAMP_PHI_0_WAD, "at the close"
        );
        assertEq(
            FeeModel.tradingFeeWad(OVERNIGHT_HOURS, OVERNIGHT_HOURS),
            Constants.RAMP_PHI_1_WAD,
            "at the open"
        );
        assertEq(
            FeeModel.tradingFeeWad(OVERNIGHT_HOURS / 2, OVERNIGHT_HOURS),
            (Constants.RAMP_PHI_0_WAD + Constants.RAMP_PHI_1_WAD) / 2,
            "midway"
        );
    }

    function test_tradingFee_isMonotoneInElapsedTime() public pure {
        uint256 previous = FeeModel.tradingFeeWad(0, OVERNIGHT_HOURS);
        for (uint256 t = 1; t <= 17; ++t) {
            uint256 current = FeeModel.tradingFeeWad(t * 1e18, OVERNIGHT_HOURS);
            assertGe(current, previous, "the ramp does not decrease");
            previous = current;
        }
    }

    function test_tradingFee_revertsBeyondTheTerm() public {
        vm.expectRevert(
            abi.encodeWithSelector(FeeModel.ElapsedBeyondTerm.selector, 18e18, OVERNIGHT_HOURS)
        );
        this.externalTradingFeeWad(18e18, OVERNIGHT_HOURS);
    }

    function test_tradingFee_revertsOnZeroTerm() public {
        vm.expectRevert(FeeModel.TermZero.selector);
        this.externalTradingFeeWad(0, 0);
    }

    /// @dev The ramp's time-average is at most `phi_0 + (phi_1 - phi_0) * 2/3 = 0.70%` whatever the
    ///      intraday shape. That ceiling is the binding fact about the tolerance range in §6.4, and
    ///      the assertion below is the guardrail the brief asks to be asserted rather than assumed.
    function test_tradingFee_staysInsideTheRampBounds() public pure {
        for (uint256 t = 0; t <= 17; ++t) {
            assertTrue(
                FeeModel.tradingFeeWithinRampBounds(t * 1e18, OVERNIGHT_HOURS), "inside the ramp"
            );
        }
        assertEq(
            Constants.RAMP_PHI_0_WAD + ((Constants.RAMP_PHI_1_WAD - Constants.RAMP_PHI_0_WAD) * 2)
                / 3,
            Constants.RAMP_TIME_AVERAGE_CEILING_WAD,
            "the ceiling is phi_0 + (phi_1 - phi_0) * 2/3"
        );
    }

    function test_tradingFeeWithinRampBounds_rejectsOutOfRangeInput() public pure {
        assertFalse(FeeModel.tradingFeeWithinRampBounds(0, 0), "zero term");
        assertFalse(FeeModel.tradingFeeWithinRampBounds(20e18, OVERNIGHT_HOURS), "beyond the term");
    }

    // ---------------------------------------------------------------- Eq (20)

    function test_volatilityScaledFee_scalesLinearlyBelowTheCap() public pure {
        // At the reference volatility the fee is phi_ref, and it doubles when volatility doubles.
        assertEq(
            FeeModel.volatilityScaledTradingFeeWad(0.02e18, 1e18),
            Constants.TRADING_FEE_REFERENCE_WAD,
            "at the reference"
        );
        assertEq(
            FeeModel.volatilityScaledTradingFeeWad(0.04e18, 1e18),
            2 * Constants.TRADING_FEE_REFERENCE_WAD,
            "linear in sigma"
        );
    }

    function test_volatilityScaledFee_respectsTheCap() public pure {
        uint256 phiMax = 0.01e18;
        assertEq(FeeModel.volatilityScaledTradingFeeWad(0.2e18, phiMax), phiMax, "capped");
    }

    function test_volatilityScaledFee_referenceIsPinnedAndNonZero() public pure {
        // The reference is a generated constant, not a caller-supplied parameter (F11 ruling). The
        // guard that used to take a zero reference now checks the constant itself, so the test
        // asserts the constant is the pinned 2% and non-zero.
        assertEq(Constants.TRADING_FEE_REFERENCE_VOLATILITY_WAD, 0.02e18, "pinned at 2%");
        assertGt(Constants.TRADING_FEE_REFERENCE_VOLATILITY_WAD, 0, "non-zero");
    }

    // ---------------------------------------------------------------- Eq (19) x Eq (20)

    function test_volatilityMultiplierWad_dividesThePriceByTheReference() public pure {
        assertEq(FeeModel.volatilityMultiplierWad(0.15e18, 0.15e18), 1e18, "at the reference");
        assertEq(FeeModel.volatilityMultiplierWad(0.3e18, 0.15e18), 2e18, "double the price");
        assertEq(FeeModel.volatilityMultiplierWad(0.075e18, 0.15e18), 0.5e18, "half the price");
    }

    /// @dev At the reference premium the multiplier is one and the fee is the pure ramp, whose
    ///      time-average is phi_ref -- the two equations agree at the reference, which is the
    ///      natural reading of Eq (20)'s "phi_ref = 0.55% at the calibration reference".
    function test_scaledTradingFee_atTheReferencePremiumIsTheRamp() public pure {
        assertEq(
            FeeModel.scaledTradingFeeWad(0, OVERNIGHT_HOURS, 0.15e18, 0.15e18),
            Constants.RAMP_PHI_0_WAD,
            "at the close"
        );
        assertEq(
            FeeModel.scaledTradingFeeWad(OVERNIGHT_HOURS, OVERNIGHT_HOURS, 0.15e18, 0.15e18),
            Constants.RAMP_PHI_1_WAD,
            "at the open"
        );
        assertEq(
            FeeModel.scaledTradingFeeWad(OVERNIGHT_HOURS / 2, OVERNIGHT_HOURS, 0.15e18, 0.15e18),
            (Constants.RAMP_PHI_0_WAD + Constants.RAMP_PHI_1_WAD) / 2,
            "midway"
        );
    }

    /// @dev The volatility multiplier is the paper's Eq (20) ratio with the pool price as the
    ///      on-chain volatility signal: `p_L / p_L_ref` is `sigma / sigma_ref` to the paper's
    ///      measured 1.2% tolerance. Doubling the price doubles the fee, below the cap; the close
    ///      is used so the doubled ramp (0.20%) stays under phi_1.
    function test_scaledTradingFee_scalesWithThePremium() public pure {
        uint256 atReference = FeeModel.scaledTradingFeeWad(0, OVERNIGHT_HOURS, 0.15e18, 0.15e18);
        assertEq(
            FeeModel.scaledTradingFeeWad(0, OVERNIGHT_HOURS, 0.3e18, 0.15e18),
            2 * atReference,
            "linear in the premium"
        );
    }

    function test_scaledTradingFee_respectsTheCap() public pure {
        // Ten times the reference premium at the open would be ten times the ramp's ceiling; the
        // fee is capped at phi_1, the same ceiling the ramp itself never exceeds.
        assertEq(
            FeeModel.scaledTradingFeeWad(OVERNIGHT_HOURS, OVERNIGHT_HOURS, 1.5e18, 0.15e18),
            Constants.RAMP_PHI_1_WAD,
            "capped at phi_1"
        );
    }

    function test_scaledTradingFee_revertsBeyondTheTerm() public {
        vm.expectRevert(
            abi.encodeWithSelector(FeeModel.ElapsedBeyondTerm.selector, 18e18, OVERNIGHT_HOURS)
        );
        this.externalScaledTradingFeeWad(18e18, OVERNIGHT_HOURS, 0.15e18, 0.15e18);
    }

    function test_scaledTradingFee_revertsOnZeroTerm() public {
        vm.expectRevert(FeeModel.TermZero.selector);
        this.externalScaledTradingFeeWad(0, 0, 0.15e18, 0.15e18);
    }

    // ---------------------------------------------------------------- external wrappers

    function externalProtocolFeeUncappedWad(uint256 termHoursWad) external pure returns (uint256) {
        return FeeModel.protocolFeeUncappedWad(termHoursWad);
    }

    function externalTradingFeeWad(uint256 elapsedHoursWad, uint256 termHoursWad)
        external
        pure
        returns (uint256)
    {
        return FeeModel.tradingFeeWad(elapsedHoursWad, termHoursWad);
    }

    function externalScaledTradingFeeWad(
        uint256 elapsedHoursWad,
        uint256 termHoursWad,
        uint256 pLWad,
        uint256 pLRefWad
    ) external pure returns (uint256) {
        return FeeModel.scaledTradingFeeWad(elapsedHoursWad, termHoursWad, pLWad, pLRefWad);
    }
}
