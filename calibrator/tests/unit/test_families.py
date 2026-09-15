"""The distributional families.

The Gaussian is tested as a *rejection*, not merely as an implementation. The brief rejects it as a
seed on a measurement -- "it prices the overnight session 29 to 42% rich" -- and a rejection that
cannot be re-measured is a preference. The test below builds a leptokurtic sample and asserts that
the Gaussian is rich on it, which is the same finding on a sample this repository holds.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from bell_calibrator.domain.constants import WAD
from bell_calibrator.domain.families import (
    FAMILIES,
    SEED_FAMILY,
    UNIMPLEMENTED_FAMILIES,
    GapSample,
    family_for,
    gaussian_premium_wad,
    seed_family,
)
from bell_calibrator.domain.families.base import (
    premium_from_truncated_mean,
    truncated_mean_wad,
)
from bell_calibrator.domain.families.gaussian import relative_error_wad
from bell_calibrator.domain.moments import truncated_abs_moment


def wad(value: str) -> int:
    return int(Decimal(value) * WAD)


#: A leptokurtic sample, built rather than drawn so the test is deterministic without a seed: 990
#: gaps of a tenth of a per cent and ten of eight per cent. The shape that matters is not the
# kurtosis
#: on its own but the ratio of the mean absolute move to the standard deviation -- 0.224 here
# against
#: 0.798 for a normal -- because the truncated moment is an average of absolute values, and a
#: fat-tailed distribution puts most of its *variance* in a few observations while most of its
#: *observations* sit far below the mean.
#:
#: The magnitudes below are larger than the paper's measured +29 to +42%, and that is expected: the
#: paper measures real gaps over a 504-session window, and this is a two-point construction chosen
# to
#: make the direction unambiguous rather than to reproduce the magnitude. The direction is the
# claim.
CALM_GAPS = (wad("0.001"),) * 990
FAT_GAPS = (wad("-0.08"),) * 5 + (wad("0.08"),) * 5
LEPTOKURTIC = GapSample(CALM_GAPS + FAT_GAPS)

#: A light-tailed sample: a discrete uniform over +/- 5.9% in steps of a tenth of a per cent. Its
#: excess kurtosis is negative, so the Gaussian's error should carry the opposite sign.
PLATYKURTIC = GapSample(
    tuple(wad(f"{step / 1000}") for step in range(1, 60))
    + tuple(wad(f"{-step / 1000}") for step in range(1, 60))
)


class TestGapSample:
    def test_an_empty_sample_is_refused(self) -> None:
        # A programmer error rather than a domain result: "the sample cannot support an estimate" is
        # ordinary, but a sample with nothing in it is a bug in the caller.
        with pytest.raises(ValueError, match="at least one observation"):
            GapSample(gaps_wad=())

    def test_the_count_is_the_number_of_observations(self) -> None:
        assert GapSample((1, 2, 3)).count == 3

    def test_magnitudes_are_unsigned(self) -> None:
        assert GapSample((-5, 3)).magnitudes_wad == (5, 3)

    def test_sigma_is_the_population_standard_deviation(self) -> None:
        # Two observations at +/- 1% have a population sigma of exactly 1%.
        sample = GapSample((wad("0.01"), wad("-0.01")))
        assert sample.sigma_wad() == wad("0.01")

    def test_sigma_of_a_constant_sample_is_zero(self) -> None:
        assert GapSample((wad("0.01"),) * 5).sigma_wad() == 0

    def test_a_one_observation_sample_has_a_sigma(self) -> None:
        # The population form divides by n, so a single observation gives zero rather than dividing
        # by zero. Whether such a sample is *usable* is the caller's question, not this one's.
        assert GapSample((wad("0.01"),)).sigma_wad() == 0

    def test_the_quantile_is_over_magnitudes(self) -> None:
        sample = GapSample(tuple(wad(f"{i / 100}") for i in range(1, 101)))
        assert sample.quantile_magnitude_wad(Decimal("0.99")) == wad("0.99")

    def test_an_out_of_range_probability_is_refused(self) -> None:
        with pytest.raises(ValueError, match="probability"):
            GapSample((1,)).quantile_magnitude_wad(Decimal("0"))


class TestTheEmpiricalSeed:
    def test_the_empirical_family_is_the_seed(self) -> None:
        assert seed_family() is FAMILIES[SEED_FAMILY]
        assert seed_family().is_seed_model

    def test_only_one_family_is_the_seed(self) -> None:
        assert [name for name, family in FAMILIES.items() if family.is_seed_model] == [SEED_FAMILY]

    def test_the_truncated_mean_caps_every_observation(self) -> None:
        # Three observations, a cap of 2%: the 5% one contributes the cap, not its own value.
        sample = GapSample((wad("0.01"), wad("0.02"), wad("0.05")))
        assert truncated_mean_wad(sample, wad("0.02")) == (
            wad("0.01") + wad("0.02") + wad("0.02")
        ) // 3

    def test_a_cap_above_every_observation_recovers_the_plain_mean(self) -> None:
        sample = GapSample((wad("0.01"), wad("0.03")))
        assert truncated_mean_wad(sample, wad("1.0")) == (wad("0.01") + wad("0.03")) // 2

    def test_a_non_positive_cap_is_refused(self) -> None:
        with pytest.raises(ValueError, match="cap"):
            truncated_mean_wad(GapSample((1,)), 0)

    def test_a_pre_truncated_sample_can_only_answer_for_the_cap_it_was_cut_at(self) -> None:
        # The distinction the paper's appendix is explicit about. A sample whose values were already
        # capped has destroyed the mass above that cap, so it can answer for that cap and no other:
        # asked about a wider cap it under-reports, because the observations it would have used are
        # gone. That is why the estimator is documented as running on the raw gaps.
        raw = GapSample((wad("0.01"), wad("0.50")))
        cut_at_five_per_cent = GapSample((wad("0.01"), wad("0.05")))
        assert truncated_mean_wad(raw, wad("0.05")) == truncated_mean_wad(
            cut_at_five_per_cent, wad("0.05")
        ), "at the cap it was cut at, the two agree"
        assert truncated_mean_wad(raw, wad("0.20")) > truncated_mean_wad(
            cut_at_five_per_cent, wad("0.20")
        ), "asked about a wider cap, the pre-truncated sample under-reports"

    def test_the_premium_is_the_truncated_mean_scaled_by_the_leverage(self) -> None:
        sample = GapSample((wad("0.01"),) * 100)
        lam = 15 * WAD
        # Every observation is below the cap, so the truncated mean is 1% and the premium is 15%.
        assert FAMILIES["empirical"].premium_wad(lam, sample) == premium_from_truncated_mean(
            lam, wad("0.01")
        )
        assert FAMILIES["empirical"].premium_wad(lam, sample) == wad("0.15")

    def test_a_fit_carries_the_family_name_and_the_observation_count(self) -> None:
        fit = FAMILIES["empirical"].fit(15 * WAD, GapSample((wad("0.01"),) * 7))
        assert fit.family == "empirical"
        assert fit.observations == 7

    def test_the_published_premium_is_the_fit_premium(self) -> None:
        """`premium_per_unit_wad` is what the registry publishes, so it must be the fit's premium.

        Two names for one quantity, and they exist because the fit speaks in premium terms while the
        commitment speaks per unit of notional. Pinned because a divergence between what a publisher
        committed and what its own fit produced is the failure the commitment mechanism exists to
        detect -- and a property that drifted would make it silent.
        """
        fit = FAMILIES["empirical"].fit(15 * WAD, GapSample((wad("0.01"),) * 100))
        assert fit.premium_per_unit_wad == fit.premium_wad
        assert fit.premium_per_unit_wad == wad("0.15")


class TestTheGaussianRejection:
    def test_the_gaussian_is_not_the_seed(self) -> None:
        assert not FAMILIES["gaussian"].is_seed_model

    def test_the_gaussian_is_rich_on_a_leptokurtic_sample(self) -> None:
        # The brief's §4.2.4 rejection, re-measured. The direction is the interesting part: the
        # error
        # is one-signed and positive, which is what "prices the overnight session rich" means, and
        # an
        # unsigned error would hide the one property that made the family unusable as a seed.
        lam = 15 * WAD
        empirical = FAMILIES["empirical"].premium_wad(lam, LEPTOKURTIC)
        gaussian = FAMILIES["gaussian"].premium_wad(lam, LEPTOKURTIC)
        assert gaussian > empirical, "the Gaussian overprices a fat-tailed sample"
        assert relative_error_wad(gaussian, empirical) > 0

    def test_the_gaussian_error_grows_with_the_leverage(self) -> None:
        # A higher leverage means a smaller cap, so more of the sample is above it -- and the mass
        # above the cap is exactly what the Gaussian gets wrong. The error is therefore monotone in
        # the leverage, which is worth knowing before publishing a leverage and a premium together.
        errors = []
        for lam in (11, 15, 22, 32):
            empirical = FAMILIES["empirical"].premium_wad(lam * WAD, LEPTOKURTIC)
            gaussian = FAMILIES["gaussian"].premium_wad(lam * WAD, LEPTOKURTIC)
            errors.append(relative_error_wad(gaussian, empirical))
        assert errors == sorted(errors), "the error is monotone in the leverage"

    def test_the_gaussian_error_is_signed_by_the_tail_shape(self) -> None:
        # The family is not wrong; it is wrong about *this* instrument's data. The sign of its error
        # tracks the shape of the tail: rich on a fat-tailed sample and poor on a light-tailed one,
        # which is why no single family can serve both and why the empirical model is the reference
        # every fitted family is scored against.
        lam = 15 * WAD
        fat_error = relative_error_wad(
            FAMILIES["gaussian"].premium_wad(lam, LEPTOKURTIC),
            FAMILIES["empirical"].premium_wad(lam, LEPTOKURTIC),
        )
        light_error = relative_error_wad(
            FAMILIES["gaussian"].premium_wad(lam, PLATYKURTIC),
            FAMILIES["empirical"].premium_wad(lam, PLATYKURTIC),
        )
        assert fat_error > 0, "rich on a fat-tailed sample"
        assert light_error < 0, "poor on a light-tailed sample"
        assert fat_error > abs(light_error), "and the fat-tailed error is the larger of the two"

    def test_the_gaussian_agrees_with_the_moment_primitive(self) -> None:
        # One implementation of Eq (12), not two: the family delegates rather than re-deriving.
        lam_wad = 15 * WAD
        sigma_wad = wad("0.0188")
        expected = premium_from_truncated_mean(
            lam_wad,
            int(
                (
                    truncated_abs_moment(
                        Decimal(lam_wad) / Decimal(WAD),
                        Decimal(0),
                        Decimal(sigma_wad) / Decimal(WAD),
                    )
                    * WAD
                ).to_integral_value(rounding="ROUND_HALF_EVEN")
            ),
        )
        assert gaussian_premium_wad(lam_wad, sigma_wad) == expected

    def test_the_relative_error_is_signed(self) -> None:
        assert relative_error_wad(110, 100) == wad("0.10")
        assert relative_error_wad(90, 100) == wad("-0.10")

    def test_a_zero_reference_is_refused(self) -> None:
        with pytest.raises(ValueError, match="non-zero reference"):
            relative_error_wad(1, 0)


class TestTheFamilyRegistry:
    def test_the_unimplemented_families_are_named(self) -> None:
        assert frozenset({"student_t", "nig", "merton"}) == UNIMPLEMENTED_FAMILIES

    def test_an_unimplemented_family_raises_a_specific_refusal(self) -> None:
        # Not a `KeyError`. A missing key reads as a typo; the absence of NIG is F10 (closed) /
        # tracker G0, and the error has to say so.
        with pytest.raises(NotImplementedError, match="F10"):
            family_for("nig")

    def test_an_unknown_family_raises_a_key_error(self) -> None:
        with pytest.raises(KeyError):
            family_for("nonsense")

    def test_every_registered_family_declares_a_name(self) -> None:
        for name, family in FAMILIES.items():
            assert family.name == name
