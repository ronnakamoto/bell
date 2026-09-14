"""Unit tests for the distributional primitives.

Every expectation here is an externally checkable value -- a published table, a textbook constant,
or a limit the paper states -- rather than a value read back from the implementation. A test that
asserts what the code already does is a change detector, not a test.
"""

from __future__ import annotations

from decimal import Decimal, localcontext

import pytest

from bell_calibrator.domain import moments

WAD = Decimal(10) ** 18


def wad(text: str) -> Decimal:
    return Decimal(text)


class TestStandardNormalDensity:
    def test_known_values(self) -> None:
        assert moments.standard_normal_pdf(Decimal(0)).quantize(Decimal("1e-15")) == Decimal(
            "0.398942280401433"
        )
        assert moments.standard_normal_pdf(Decimal(1)).quantize(Decimal("1e-15")) == Decimal(
            "0.241970724519143"
        )

    def test_is_even(self) -> None:
        for x in ("0.5", "1", "2.5", "4"):
            assert moments.standard_normal_pdf(wad(x)) == moments.standard_normal_pdf(-wad(x))


class TestStandardNormalCdf:
    def test_origin_is_one_half(self) -> None:
        assert moments.standard_normal_cdf(Decimal(0)) == Decimal("0.5")

    def test_textbook_values(self) -> None:
        assert moments.standard_normal_cdf(wad("1.96")).quantize(Decimal("1e-15")) == Decimal(
            "0.975002104851780"
        )
        assert moments.standard_normal_cdf(wad("-1.96")).quantize(Decimal("1e-15")) == Decimal(
            "0.024997895148220"
        )

    def test_deep_tail_matches_the_asymptotic_value(self) -> None:
        # Phi(-7) = 1.279812543885835004383623690780832998035e-12. The continued-fraction branch is
        # what makes this reachable: the Maclaurin series would have lost every digit to
        # cancellation here. Compared relatively because `quantize` is bounded by the ambient
        # decimal context, which is coarser than this module's working precision.
        true_value = Decimal("1.279812543885835004383623690780832998035E-12")
        computed = moments.standard_normal_cdf(Decimal(-7))
        assert abs(computed - true_value) / true_value < Decimal("1e-40")

    def test_is_monotone_and_bounded(self) -> None:
        previous = Decimal(0)
        step = Decimal("0.25")
        x = Decimal(-10)
        while x <= 10:
            current = moments.standard_normal_cdf(x)
            assert current >= previous
            assert 0 <= current <= 1
            previous = current
            x += step


class TestTruncatedAbsMoment:
    def test_zero_sigma_is_zero(self) -> None:
        assert moments.truncated_abs_moment(wad("15"), Decimal(0), Decimal(0)) == Decimal(0)

    def test_the_cap_form_refuses_a_zero_sigma(self) -> None:
        """The cap form divides by sigma, so it refuses a zero rather than raising a division error.

        `truncated_abs_moment` handles `sigma == 0` before it delegates, so this guard is reachable
        only by calling the cap form directly -- which is why it had never fired. It is public API:
        a caller holding a cap rather than a leverage is meant to use it, and it should fail with a
        message that says what is wrong.
        """
        with pytest.raises(ValueError, match="non-zero sigma"):
            moments.truncated_abs_moment_at_cap(wad("0.05"), Decimal(0))

    def test_zero_leverage_is_the_untruncated_mean(self) -> None:
        # The paper's stated c -> infinity limit: the moment tends to sigma * sqrt(2/pi), the
        # expected absolute move. This is what makes the two branches continuous at the boundary,
        # so the equality is exact rather than approximate.
        sigma = wad("0.0188")
        assert moments.truncated_abs_moment(Decimal(0), Decimal(0), sigma) == (
            sigma * moments.SQRT_TWO_OVER_PI
        )

    def test_rejects_a_non_zero_mean(self) -> None:
        with pytest.raises(ValueError, match="zero mean"):
            moments.truncated_abs_moment(wad("15"), wad("0.001"), wad("0.02"))

    def test_matches_the_paper_equation_twelve(self) -> None:
        # E[min(|G|, 1/15)] at sigma = 1.88%, computed independently in the recon harness.
        value = moments.truncated_abs_moment(wad("15"), Decimal(0), wad("0.0188"))
        assert value.quantize(Decimal("1e-12")) == Decimal("0.014998401026")

    def test_is_monotone_decreasing_in_leverage(self) -> None:
        # A larger leverage means a smaller cap, and truncating harder cannot raise the mean.
        # Sigma is 20% rather than a realistic session volatility because the property is only
        # exercised where the caps actually bind: at sigma = 2%, a cap of 1 and a cap of 1/64
        # truncate nothing at all, so the two moments agree to fifty digits and the ordering is
        # vacuous rather than false.
        sigma = wad("0.2")
        previous = moments.truncated_abs_moment(wad("1"), Decimal(0), sigma)
        for lam in ("2", "4", "8", "16", "32", "64"):
            current = moments.truncated_abs_moment(wad(lam), Decimal(0), sigma)
            assert current < previous
            previous = current

    def test_is_monotone_increasing_in_sigma(self) -> None:
        previous = Decimal(0)
        for sigma in ("0.005", "0.01", "0.02", "0.04", "0.08"):
            current = moments.truncated_abs_moment(wad("15"), Decimal(0), wad(sigma))
            assert current > previous
            previous = current


class TestTruncatedFirstMoment:
    def test_zero_sigma_is_zero(self) -> None:
        assert moments.truncated_first_moment(wad("15"), Decimal(0)) == Decimal(0)

    def test_zero_leverage_is_the_untruncated_first_moment(self) -> None:
        sigma = wad("0.02")
        assert moments.truncated_first_moment(Decimal(0), sigma) == (
            sigma * moments.SQRT_TWO_OVER_PI
        )


class TestConstantsAreInternallyConsistent:
    """The module's constants, checked against each other and against their definitions.

    This class exists because a swap between `2 / sqrt(pi)` and `sqrt(2 / pi)` is silent: both are
    plausible-looking constants, both appear in this domain, and using one for the other
    scales every result by 29% without raising anything. That mistake was made and caught here.
    """

    def test_maclaurin_coefficient_is_two_over_sqrt_pi(self) -> None:
        # Finite literals cannot be exactly consistent, so the assertion is a relative bound rather
        # than equality. 1e-45 is well inside the 50 digits the constants carry and far below any
        # quantity this module computes.
        with localcontext() as context:
            context.prec = 60
            product = moments.TWO_OVER_SQRT_PI * moments.SQRT_PI
            assert abs(product - 2) / 2 < Decimal("1e-45")

    def test_absolute_mean_coefficient_is_sqrt_two_over_pi(self) -> None:
        # E[|Z|] for a standard normal is sqrt(2/pi). Multiplying it by pi gives sqrt(2*pi),
        # the other constant in this module, so the relationship is checkable without restating
        # either value.
        with localcontext() as context:
            context.prec = 60
            pi = Decimal("3.14159265358979323846264338327950288419716939937510582097494")
            assert (
                abs(moments.SQRT_TWO_OVER_PI * pi - moments.SQRT_TWO_PI) / moments.SQRT_TWO_PI
                < Decimal("1e-45")
            )

    def test_the_two_coefficients_differ_by_a_factor_of_sqrt_two(self) -> None:
        # (2/sqrt(pi)) / sqrt(2/pi) = sqrt(2). Both appear in this domain and swapping them
        # scales every result by 29%, so the relationship is worth pinning.
        with localcontext() as context:
            context.prec = 60
            ratio = moments.TWO_OVER_SQRT_PI / moments.SQRT_TWO_OVER_PI
            assert abs(ratio - moments.SQRT_TWO) / moments.SQRT_TWO < Decimal("1e-45")

    def test_sqrt_pi_and_sqrt_two_pi_are_consistent(self) -> None:
        with localcontext() as context:
            context.prec = 60
            ratio = moments.SQRT_TWO_PI / moments.SQRT_PI
            assert abs(ratio - moments.SQRT_TWO) / moments.SQRT_TWO < Decimal("1e-45")

    def test_constants_carry_more_than_the_default_context_precision(self) -> None:
        # A module-level constant computed with a division would be evaluated in the default
        # 28-digit context and would silently cap every downstream result. Literals must be longer.
        for name in ("SQRT_PI", "SQRT_TWO", "SQRT_TWO_PI", "TWO_OVER_SQRT_PI", "SQRT_TWO_OVER_PI"):
            digits = len(getattr(moments, name).as_tuple().digits)
            assert digits > 40, f"{name} carries only {digits} digits"

    def test_is_the_numeric_derivative_of_the_premium(self) -> None:
        # dp/dlambda = E[|G| 1{|G| <= 1/lambda}], which is the derivative of p = lambda * moment.
        # Checked as a central difference, because the identity is a derivative and asserting it any
        # other way would be asserting a restatement.
        sigma = wad("0.0188")
        lam = wad("15")
        step = Decimal("0.0001")
        upper = (lam + step) * moments.truncated_abs_moment(lam + step, Decimal(0), sigma)
        lower = (lam - step) * moments.truncated_abs_moment(lam - step, Decimal(0), sigma)
        numeric = (upper - lower) / (2 * step)
        analytic = moments.truncated_first_moment(lam, sigma)
        assert abs(numeric - analytic) / analytic < Decimal("1e-6")

    def test_is_below_the_untruncated_first_moment(self) -> None:
        sigma = wad("0.02")
        untruncated = moments.truncated_first_moment(Decimal(0), sigma)
        assert moments.truncated_first_moment(wad("15"), sigma) < untruncated
