"""The Gaussian family: the rejected seed.

Implemented rather than omitted, because the brief's §4.2.4 rejects it on a *measurement* -- "it
prices the overnight session 29 to 42% rich" -- and a rejection that cannot be re-measured is a
preference. The family is here so that the error it makes is reproducible against whatever sample is
in hand, and so that the differential suite has a closed form to check the Solidity side against.

Why it fails is worth stating precisely, because it is not that the Gaussian is wrong about
volatility. It is that the payoff is a function of the *truncated* absolute moment, and that moment
depends on the shape of the distribution above the cap as well as on its scale. Measured overnight
excess kurtosis is 30.7, so a Gaussian fitted to the same variance places far less mass above the
cap
than the data does -- and the premium is the area under the payoff, so it comes out rich by exactly
the mass the Gaussian puts in the wrong place.
"""

from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal

from bell_calibrator.domain.constants import WAD
from bell_calibrator.domain.families.base import FamilyFit, GapSample, premium_from_truncated_mean
from bell_calibrator.domain.moments import truncated_abs_moment


class GaussianFamily:
    """A normal fitted to the sample's mean and variance."""

    @property
    def name(self) -> str:
        return "gaussian"

    @property
    def is_seed_model(self) -> bool:
        """Not the seed, and the brief forbids it as one."""
        return False

    def premium_wad(self, lam_wad: int, sample: GapSample) -> int:
        """`lambda * E[min(|G|, 1/lambda)]` for `G ~ N(0, sigma^2)`.

        The closed form of paper Eq (12), evaluated by the same primitive the differential fixture
        checks the Solidity implementation against. Delegating rather than re-deriving is what keeps
        one implementation of the formula in the repository.
        """
        return gaussian_premium_wad(lam_wad, sample.sigma_wad())

    def fit(self, lam_wad: int, sample: GapSample) -> FamilyFit:
        return FamilyFit(
            family=self.name,
            lam_wad=lam_wad,
            premium_wad=self.premium_wad(lam_wad, sample),
            observations=sample.count,
        )


def gaussian_premium_wad(lam_wad: int, sigma_wad: int) -> int:
    """The Gaussian premium from a sigma, without a sample.

    Exposed because the differential fixture carries `(sigma, lambda)` rather than a sample, and the
    fixture is what the Solidity side is checked against. A second entry point rather than a second
    implementation: both call `truncated_abs_moment`.
    """
    moment = truncated_abs_moment(dimensionless(lam_wad), Decimal(0), dimensionless(sigma_wad))
    return premium_from_truncated_mean(lam_wad, to_wad(moment))


def dimensionless(wad_value: int) -> Decimal:
    """A WAD integer as the dimensionless `Decimal` the moment primitive takes."""
    return Decimal(wad_value) / Decimal(WAD)


def to_wad(value: Decimal) -> int:
    """A dimensionless `Decimal` back at WAD scale, rounded half-even.

    Half-even rather than truncated: the primitive computes at fifty digits and the WAD grid has
    eighteen, so a quantisation is unavoidable and the cost is half a wei either way. Truncating
    would bias every premium downwards, and a one-signed bias in the direction of cheapness is the
    wrong one for a protocol that writes the premium into a bond.
    """
    return int((value * WAD).to_integral_value(rounding=ROUND_HALF_EVEN))


def relative_error_wad(estimated: int, reference: int) -> int:
    """`(estimated - reference) / reference`, signed, at WAD scale.

    Signed, because the direction of a model's error is the interesting part: the Gaussian's error
    is
    one-signed and positive, which is what "prices the overnight session rich" means, and an
    unsigned
    error would hide the one property that made the family unusable as a seed.
    """
    if reference == 0:
        raise ValueError("a relative error needs a non-zero reference")
    return ((estimated - reference) * WAD) // reference
