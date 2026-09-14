"""Unit tests for the leverage rule and the cap lattice."""

from __future__ import annotations

from decimal import Decimal

import pytest

from bell_calibrator.domain import constants, leverage
from bell_calibrator.domain.models import Wad

WAD = 10**18


def wad(text: str) -> Wad:
    return Wad.from_str(text)


class TestEmpiricalQuantile:
    def test_nearest_rank(self) -> None:
        sample = [Wad(n * WAD // 10) for n in range(1, 11)]  # 0.1 .. 1.0
        assert leverage.empirical_quantile(sample, Decimal("0.5")) == Wad(5 * WAD // 10)
        assert leverage.empirical_quantile(sample, Decimal("0.99")) == Wad(10 * WAD // 10)

    def test_single_observation(self) -> None:
        only = Wad(3 * WAD)
        assert leverage.empirical_quantile([only], Decimal("0.99")) == only

    def test_is_independent_of_input_order(self) -> None:
        sample = [Wad(n * WAD // 7) for n in (5, 1, 7, 3, 2)]
        ascending = sorted(sample)
        assert leverage.empirical_quantile(sample, Decimal("0.8")) == (
            leverage.empirical_quantile(ascending, Decimal("0.8"))
        )

    def test_refuses_an_empty_sample(self) -> None:
        # A default here would become a leverage, and a leverage built on an absent sample is a
        # parameter the protocol would price against.
        with pytest.raises(ValueError, match="at least one observation"):
            leverage.empirical_quantile([], Decimal("0.99"))

    def test_refuses_an_out_of_range_probability(self) -> None:
        with pytest.raises(ValueError, match="probability"):
            leverage.empirical_quantile([Wad(WAD)], Decimal("0"))


class TestCapAndLeverage:
    def test_cap_is_the_reciprocal_of_leverage(self) -> None:
        assert leverage.cap_for_leverage(Wad(15 * WAD)) == Wad(WAD // 15)
        assert leverage.cap_for_leverage(Wad(1 * WAD)) == Wad(WAD)
        assert leverage.cap_for_leverage(Wad(100 * WAD)) == Wad(WAD // 100)

    def test_leverage_for_cap_floors(self) -> None:
        # Floored, not rounded: a leverage above 1/cap saturates more often than the stated alpha.
        assert leverage.leverage_for_cap(Wad(WAD // 15)) == Wad(15 * WAD)
        assert leverage.leverage_for_cap(Wad(WAD // 15 + 1)) == Wad(14 * WAD)

    def test_round_trip_on_the_lattice(self) -> None:
        for units in (1, 4, 10, 11, 15, 16, 22, 32, 100):
            lam = Wad(units * WAD)
            assert leverage.leverage_for_cap(leverage.cap_for_leverage(lam)) == lam

    def test_rejects_a_non_positive_cap(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            leverage.leverage_for_cap(Wad(0))

    def test_cap_for_leverage_rejects_a_non_positive_leverage(self) -> None:
        """The same guard as `saturation_gap`'s, and it had no test.

        `TestSaturationGap.test_rejects_a_non_positive_leverage` covers the threshold function; the
        reciprocal carries the identical check and nothing exercised it. Two functions with one rule
        between them is exactly the shape where one of the two goes untested, because the suite
        looks like it covers the rule.
        """
        with pytest.raises(ValueError, match="a leverage must be positive"):
            leverage.cap_for_leverage(Wad(0))

        with pytest.raises(ValueError, match="a leverage must be positive"):
            leverage.cap_for_leverage(Wad(-1))


class TestSaturationGap:
    """The threshold the saturation predicate uses, which rounds the other way to the reciprocal."""

    def test_rounds_up_to_the_smallest_saturating_gap(self) -> None:
        # 1/15 is 66666666666666666.67 wei, so the threshold is ...667. Rounding down would place it
        # a wei below the true crossing and make the saturation count disagree with the payoff.
        assert leverage.saturation_gap(Wad(15 * WAD)) == Wad(66666666666666667)
        assert leverage.saturation_gap(Wad(1 * WAD)) == Wad(WAD)
        assert leverage.saturation_gap(Wad(100 * WAD)) == Wad(WAD // 100)
        assert leverage.saturation_gap(Wad(32 * WAD)) == Wad(3125 * WAD // 100_000)

    def test_is_never_below_the_reciprocal(self) -> None:
        # They agree only when lambda divides 1e36, which is rare. The gap is never smaller.
        for units in (1, 2, 4, 10, 11, 15, 16, 22, 32, 100):
            lam = Wad(units * WAD)
            assert leverage.saturation_gap(lam) >= leverage.cap_for_leverage(lam)

    def test_differs_from_the_reciprocal_when_lambda_does_not_divide_the_square(self) -> None:
        # lambda = 15 is the canonical case: 15 does not divide 1e36, so the two differ by a wei.
        lam = Wad(15 * WAD)
        assert leverage.saturation_gap(lam) != leverage.cap_for_leverage(lam)
        assert leverage.saturation_gap(lam) - leverage.cap_for_leverage(lam) == Wad(1)

    def test_a_gap_one_wei_below_the_threshold_does_not_saturate(self) -> None:
        lam = Wad(15 * WAD)
        threshold = leverage.saturation_gap(lam)
        below = Wad(threshold.raw - 1)
        assert below.raw < threshold.raw
        # The payoff's own crossing, expressed as the leverage times the gap, agrees with the
        # threshold rather than with the reciprocal.
        assert (lam * below).raw // WAD < WAD

    def test_rejects_a_non_positive_leverage(self) -> None:
        with pytest.raises(ValueError, match="positive"):
            leverage.saturation_gap(Wad(0))


class TestRoundingLattice:
    def test_rounds_up(self) -> None:
        lattice = Wad(constants.ROUNDING_LATTICE_WAD)
        # 1/15 is 6.667%, whose 0.25% grid neighbours are 6.5% and 6.75%. Up means 6.75%.
        assert leverage.round_cap_up_to_lattice(Wad(WAD // 15), lattice) == Wad(675 * WAD // 10_000)
        # 1/20 is exactly 5.00%, which is already a grid point.
        assert leverage.round_cap_up_to_lattice(Wad(WAD // 20), lattice) == Wad(50 * WAD // 1000)

    def test_leaves_an_on_grid_cap_alone(self) -> None:
        lattice = Wad(constants.ROUNDING_LATTICE_WAD)
        on_grid = Wad(25 * WAD // 1000)
        assert leverage.round_cap_up_to_lattice(on_grid, lattice) == on_grid

    def test_rounds_up_not_to_nearest(self) -> None:
        # The direction is load-bearing. A larger cap is a smaller leverage, which saturates less
        # often; rounding to nearest would put half the published leverages on the unsafe side of
        # the one number the rule exists to control. A cap one wei above a grid point must therefore
        # move to the *next* grid point, not back to the nearer one.
        lattice = Wad(constants.ROUNDING_LATTICE_WAD)
        just_over = Wad(25 * WAD // 1000 + 1)
        assert leverage.round_cap_up_to_lattice(just_over, lattice) == Wad(275 * WAD // 10_000)

    def test_reproduces_the_papers_published_lattice_sensitivity(self) -> None:
        # Paper §6.1: "a 1% lattice gives lambdaE = 16, a 0.5% lattice gives 18, and 0.25% gives the
        # published 19." Reconstructed from a pre-lattice cap of 5.155%, i.e. a raw leverage of
        # about 19.4. This is the check that the rule is the paper's rule.
        raw_cap = Wad(51_550 * WAD // 1_000_000)
        expected = {"0.01": 16, "0.005": 18, "0.0025": 19}
        for spacing, published in expected.items():
            lattice = Wad.from_str(spacing)
            lam = leverage.lattice_leverage(raw_cap, lattice)
            assert lam.raw // WAD == published, f"grid {spacing}"

    def test_rejects_a_non_positive_spacing(self) -> None:
        with pytest.raises(ValueError, match="spacing"):
            leverage.round_cap_up_to_lattice(Wad(WAD), Wad(0))


class TestHarmonicLadder:
    def test_whole_leverages_are_on_the_ladder(self) -> None:
        for units in (1, 4, 10, 11, 15, 16, 22, 32, 100):
            assert leverage.is_on_harmonic_ladder(Wad(units * WAD))

    def test_fractional_leverages_are_not(self) -> None:
        assert not leverage.is_on_harmonic_ladder(Wad(WAD // 2))
        assert not leverage.is_on_harmonic_ladder(Wad(0))

    def test_the_canonical_set_is_on_the_ladder(self) -> None:
        # Every leverage in the paper's Table 13, which is the fixture the lattice gate must not
        # reject. The build brief's "harmonic lattice of integer leverages" would refuse six of
        # these nine; see DESIGN_NOTES.md F2.
        for units in (15, 11, 22, 11, 10, 16, 22, 11, 32):
            assert leverage.is_on_harmonic_ladder(Wad(units * WAD))


class TestSaturationRate:
    def test_a_constant_series_above_the_cap_always_saturates(self) -> None:
        sample = [Wad(WAD // 10) for _ in range(10)]  # every gap is 10%
        assert leverage.realised_saturation_rate(sample, Wad(15 * WAD)) == Decimal(1)

    def test_a_constant_series_below_the_cap_never_saturates(self) -> None:
        sample = [Wad(WAD // 100) for _ in range(10)]  # every gap is 1%
        assert leverage.realised_saturation_rate(sample, Wad(15 * WAD)) == Decimal(0)

    def test_refuses_an_empty_sample(self) -> None:
        with pytest.raises(ValueError, match="at least one observation"):
            leverage.realised_saturation_rate([], Wad(15 * WAD))
