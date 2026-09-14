"""The distributional family strategy, and the sample it is fitted to.

Four families are named in the paper -- Gaussian, Student-t, normal-inverse-Gaussian and Merton
jump-diffusion -- and the brief's §5.2 names the family set as one of the two places a **Strategy**
is
required, because it is an open set that must be selectable and comparable at runtime. The
comparison is the point: the paper's Table 18 ranks them on their premium error against the
empirical
distribution, and a family that is not implemented cannot be ranked.

`GapSample` carries the raw gaps rather than a summary. The empirical family is the seed model and
it
needs every observation, and a fitted family needs enough to estimate its own parameters -- so a
sample reduced to a mean and a variance at the boundary would decide the family question before the
family was chosen.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from bell_calibrator.domain.constants import WAD


@dataclass(frozen=True, slots=True)
class GapSample:
    """A set of observed gaps, at WAD scale.

    Immutable, and it validates once at construction rather than at every use: a sample with no
    observations is refused here, so no family has to decide what to do with one. "The sample cannot
    support an estimate" is a domain result, but an *empty* sample is a programmer error.
    """

    gaps_wad: tuple[int, ...]

    def __post_init__(self) -> None:
        if not self.gaps_wad:
            raise ValueError("a gap sample needs at least one observation")

    @property
    def count(self) -> int:
        return len(self.gaps_wad)

    @property
    def magnitudes_wad(self) -> tuple[int, ...]:
        """`|G|` for every observation, which is what the payoff and the leverage rule both read."""
        return tuple(abs(gap) for gap in self.gaps_wad)

    def sigma_wad(self) -> int:
        """The sample standard deviation, at WAD scale.

        The population form -- dividing by `n` rather than `n - 1` -- because the sample is the
        whole
        of what the window holds rather than a draw from a larger population, and because a
        one-observation sample would divide by zero under the other convention. A one-observation
        sample is admitted here and refused by the caller, which is the layer that can say why.
        """
        n = Decimal(self.count)
        mean = Decimal(sum(self.gaps_wad)) / n
        variance = sum((Decimal(gap) - mean) ** 2 for gap in self.gaps_wad) / n
        return int(variance.sqrt())

    def quantile_magnitude_wad(self, probability: Decimal) -> int:
        """The `probability` quantile of `|G|`, by the nearest-rank rule.

        Mirrors `bell_calibrator.domain.leverage.empirical_quantile` but over magnitudes, because
        the
        leverage rule reads `Q_(1-alpha)(|G|)` and the sign of a gap is not a volatility quantity.
        """
        if not 0 < probability <= 1:
            raise ValueError("probability must lie in (0, 1]")
        ordered = sorted(self.magnitudes_wad)
        rank = int((probability *
        Decimal(len(ordered))).to_integral_value(rounding="ROUND_CEILING"))
        return ordered[rank - 1]


@dataclass(frozen=True, slots=True)
class FamilyFit:
    """A family's estimate of the fair premium, and the leverage it was asked about."""

    family: str
    lam_wad: int
    premium_wad: int
    observations: int

    @property
    def premium_per_unit_wad(self) -> int:
        """The premium as a fraction of the notional, which is what the registry publishes."""
        return self.premium_wad


class DistributionFamily(Protocol):
    """One distributional family.

    A `Protocol` rather than an abstract base class, so a family is any object with these members
    and
    a numerical routine that lives in an adapter can satisfy it without importing the domain.
    """

    @property
    def name(self) -> str:
        """The family's name, as the paper's Table 18 lists it."""
        ...

    @property
    def is_seed_model(self) -> bool:
        """Whether the paper names this as the seed model.

        Exactly one family is the seed, and the flag exists so that "which family produced this
        published parameter" is answerable from the parameter set rather than from a comment.
        """
        ...

    def premium_wad(self, lam_wad: int, sample: GapSample) -> int:
        """The fair premium of the long claim at this leverage, at WAD scale.

        `lambda * E[min(|G|, 1/lambda)]`. The family decides how the expectation is taken -- from
        the
        sample directly, or from a fitted density -- and nothing else about the answer changes.
        """
        ...

    def fit(self, lam_wad: int, sample: GapSample) -> FamilyFit:
        """The premium, wrapped with the family's name and the observation count."""
        ...


def truncated_mean_wad(sample: GapSample, cap_wad: int) -> int:
    """`E[min(|G|, cap)]` taken directly from the sample.

    The seed model's estimator, and the reference every fitted family is scored against. Computed on
    the raw gaps so that the cap is a true truncation rather than a mean of pre-truncated values --
    the distinction the paper's appendix is explicit about, because a pre-truncated mean cannot
    recover the mass above the cap that the payoff depends on.
    """
    if cap_wad <= 0:
        raise ValueError("a truncation cap must be positive")
    total = sum(min(magnitude, cap_wad) for magnitude in sample.magnitudes_wad)
    return total // sample.count


def premium_from_truncated_mean(lam_wad: int, truncated_mean: int) -> int:
    """`lambda * E[min(|G|, 1/lambda)]`, floored to the collateral unit at WAD scale."""
    return (lam_wad * truncated_mean) // WAD
