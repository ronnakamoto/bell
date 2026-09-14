// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Constants} from "../generated/Constants.sol";
import {WadMath} from "./WadMath.sol";

/// @title FeeModel
/// @notice The two fees, as pure functions with named predicates.
/// @dev Two fees exist and they are not interchangeable. The protocol fee is charged on redemption
///      and is specified as an *annualised rate* prorated by term; the trading fee is paid to
///      liquidity providers and rises into the open to compensate them for adverse selection. The
///      ramp and the cap are exposed as separate predicates rather than folded into the fee
///      functions, so that "the fee stayed inside its guardrail" is an assertion a test can make
///      rather than a property a reader has to re-derive.
library FeeModel {
    /// @dev Thrown when a term of zero hours is supplied, where the annualised proration is
    ///      undefined.
    error TermZero();

    /// @dev Thrown when a trading fee is requested at an elapsed time beyond the term.
    error ElapsedBeyondTerm(uint256 elapsedHours, uint256 termHours);

    /// @dev Thrown when the volatility scaling reference is zero.
    error ReferenceVolatilityZero();

    /// @notice The protocol fee for a term, after the premium cap is applied.
    /// @param pLWad fair premium of the long claim at WAD scale.
    /// @param termHoursWad session length in hours at WAD scale.
    /// @return The lower of the term-prorated annualised rate and `0.05 * pL`, at WAD scale.
    /// @dev Paper Eq (17) with Eq (18). The fee is a *rate*, never a flat amount: a flat 1% charge
    ///      annualises to 500.6% on an overnight session, 133.7% over a weekend and 12.17% over a
    ///      month -- a spread of 41.1x across products that differ only in term (check K10). The
    ///      cap is the second, independent constraint: it guards the case where the premium
    ///      compresses without the term changing.
    function protocolFeeWad(uint256 pLWad, uint256 termHoursWad) internal pure returns (uint256) {
        return WadMath.min(protocolFeeUncappedWad(termHoursWad), protocolFeeCapWad(pLWad));
    }

    /// @notice The term-prorated annualised protocol fee, before the premium cap.
    /// @param termHoursWad session length in hours at WAD scale. Fractional, because the sessions
    ///        this prices are: the overnight term is 17.5 hours and the weekend is 65.5, and a
    ///        whole-hour parameter would round the flagship session by 3% and its fee with it.
    /// @dev Paper Eq (17): `eta_k = eta_ann * T_k / 8760h`. At a 17.5h overnight term this is
    ///      2.397 bp and at 65.5h it is 8.97 bp, so the implied annual rate is 12.00% on every term
    ///      by construction (check P10).
    function protocolFeeUncappedWad(uint256 termHoursWad) internal pure returns (uint256) {
        if (termHoursWad == 0) revert TermZero();
        return (Constants.PROTOCOL_FEE_ANNUALISED_WAD * termHoursWad)
            / (Constants.HOURS_PER_YEAR * Constants.WAD);
    }

    /// @notice The premium-linked ceiling on the protocol fee.
    /// @dev Paper Eq (18): `eta_k <= beta * p_L` with `beta = 0.05`. At a premium of 0.228 it
    ///      permits 114 bp against a 9.0 bp charge, so it does not bind in normal conditions and
    ///      binds only under stress -- which is what a backstop is for (check P12).
    function protocolFeeCapWad(uint256 pLWad) internal pure returns (uint256) {
        return WadMath.mulWad(Constants.PROTOCOL_FEE_CAP_OF_PREMIUM_WAD, pLWad);
    }

    /// @notice Whether the premium cap, rather than the term, is the binding constraint.
    /// @dev Named and separate so the boundary is testable directly rather than inferred from two
    ///      fee values.
    function protocolFeeIsCapped(uint256 pLWad, uint256 termHours) internal pure returns (bool) {
        return protocolFeeCapWad(pLWad) < protocolFeeUncappedWad(termHours);
    }

    /// @notice The trading fee at a point in the closed session.
    /// @param elapsedHours hours elapsed since the reference close.
    /// @param termHours total session length in hours.
    /// @return `phi_0 + (phi_1 - phi_0) * elapsed / term`, at WAD scale.
    /// @dev Paper Eq (19). The fee rises into the open because adverse selection does: as the open
    ///      approaches, the gap is progressively revealed through pre-market signals, foreign-listing
    ///      cross-reads, index futures and single-name news, so informed flow arrives late and
    ///      liquidity providers face their maximum adverse selection in the final hours.
    ///
    ///      Note what this ramp does *not* do: it does not scale the fee level with volatility, and
    ///      the two are not equivalent. The time-average of a ramp bounded by `phi_0` and `phi_1` is
    ///      at most `phi_0 + (phi_1 - phi_0) * 2/3` whatever the intraday shape -- see
    ///      `RAMP_TIME_AVERAGE_CEILING_WAD` -- which is why the high anchor of the paper's §6.4
    ///      tolerance range is unreachable by reweighting alone.
    function tradingFeeWad(uint256 elapsedHours, uint256 termHours)
        internal
        pure
        returns (uint256)
    {
        if (termHours == 0) revert TermZero();
        if (elapsedHours > termHours) revert ElapsedBeyondTerm(elapsedHours, termHours);
        uint256 span = Constants.RAMP_PHI_1_WAD - Constants.RAMP_PHI_0_WAD;
        return Constants.RAMP_PHI_0_WAD + (span * elapsedHours) / termHours;
    }

    /// @notice Whether a trading fee sits inside the ramp's own bounds.
    /// @dev The guardrail the brief's §4.1.8 asks to be asserted rather than assumed. It holds for
    ///      every `elapsed` in `[0, term]`; the test exists so that a future change to the ramp
    ///      (a floor, a reweight, a volatility term folded in) cannot quietly leave the range.
    function tradingFeeWithinRampBounds(uint256 elapsedHours, uint256 termHours)
        internal
        pure
        returns (bool)
    {
        if (termHours == 0 || elapsedHours > termHours) return false;
        uint256 fee = tradingFeeWad(elapsedHours, termHours);
        return fee >= Constants.RAMP_PHI_0_WAD && fee <= Constants.RAMP_PHI_1_WAD;
    }

    /// @notice The trading fee scaled by realised volatility, capped.
    /// @param sigmaRealisedWad realised session volatility at WAD scale.
    /// @param sigmaReferenceWad the calibration reference volatility at WAD scale; must be non-zero.
    /// @param phiMaxWad the ceiling on the scaled fee at WAD scale.
    /// @return `min(phi_ref * sigma_realised / sigma_ref, phi_max)`.
    /// @dev Paper Eq (20). The break-even condition makes the required fee linear in the premium,
    ///      and the premium is linear in sigma over the range that matters -- measured across
    ///      sigma = 1-3%, the ratio `p_L / sigma` is constant to within 1.2%. A fee that must cover
    ///      a liability proportional to sigma has to be proportional to sigma as well.
    ///
    ///      `phi_ref` is a fee and `sigma_reference` is a volatility; the two are separate
    ///      parameters because the paper pins only the first. Its Eq (20) names a "calibration
    ///      reference" without a number, so the reference volatility is supplied by the calibrator
    ///      rather than baked in here. See DESIGN_NOTES.md F11.
    ///
    ///      The honest note from the paper's simulation is that this does not raise the *median*
    ///      fee: the median turnover is near 1x and the level multiplier is near 1 there. What it
    ///      changes is the mean and the upper tail, which is where the liquidity provider's exposure
    ///      actually is.
    function volatilityScaledTradingFeeWad(
        uint256 sigmaRealisedWad,
        uint256 sigmaReferenceWad,
        uint256 phiMaxWad
    ) internal pure returns (uint256) {
        if (sigmaReferenceWad == 0) revert ReferenceVolatilityZero();
        uint256 scaled = WadMath.divWad(
            WadMath.mulWad(Constants.TRADING_FEE_REFERENCE_WAD, sigmaRealisedWad), sigmaReferenceWad
        );
        return WadMath.min(scaled, phiMaxWad);
    }
}
