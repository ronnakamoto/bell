"""The leverage rule and the cap lattice.

`lambda* = 1 / Q_(1-alpha)(|G|)` with `alpha = 0.01`. The rule has a deliberate safety property:
`P(lambda* |G| >= 1) = alpha`, so saturation happens by construction rather than by accident.

The rounding lattice is the second half of the rule and is easy to miss. The published leverage
values depend on the grid the cap is rounded to -- a 1% grid gives 16, a 0.5% grid gives 18, and
0.25% gives the published 19 -- so the grid is load-bearing and is stated in `spec/constants.yaml`.
The traded strikes are a different object again: the harmonic ladder of caps of the form `1/n`,
because on the published 0.25% grid 68 of 79 caps are not listed markets (paper §6.1, Table 26).

Pure: a sequence of gaps in, a leverage out.
"""

from __future__ import annotations

from collections.abc import Sequence
from decimal import ROUND_CEILING, Decimal

from bell_calibrator.domain import constants
from bell_calibrator.domain.models import Wad


def empirical_quantile(observations: Sequence[Wad], probability: Decimal) -> Wad:
    """The `probability` quantile of `observations`, by the nearest-rank rule.

    Nearest-rank rather than an interpolating definition because the quantity being estimated is an
    order statistic that the leverage rule then floors: interpolation would invent precision the
    published integer cannot carry, and would put a value between two observed gaps.

    Refuses an empty sample rather than returning a default. A default here would become a leverage,
    and a leverage built on an absent sample is a parameter the protocol would price against
    (build brief §8.4, "silent failure").
    """
    if not observations:
        raise ValueError("a quantile needs at least one observation")
    if not 0 < probability <= 1:
        raise ValueError("probability must lie in (0, 1]")

    ordered = sorted(observation.raw for observation in observations)
    rank = _ceiling(probability * Decimal(len(ordered)))
    return Wad(ordered[rank - 1])


def leverage_for_cap(cap: Wad) -> Wad:
    """`floor(1 / cap)`, as a whole-number leverage.

    Floored rather than rounded: a leverage above `1 / cap` would saturate more often than the
    stated `alpha`, and the rule's whole purpose is that the saturation probability is a chosen
    number rather than an observed one.
    """
    if cap.raw <= 0:
        raise ValueError("a cap must be positive")
    units = (constants.WAD * constants.WAD) // cap.raw
    return Wad((units // constants.WAD) * constants.WAD)


def cap_for_leverage(lam: Wad) -> Wad:
    """`1 / lambda`, the saturation point, rounded down.

    The reciprocal, used for reporting a cap as a percentage and for the lattice rule. This is *not*
    the threshold the saturation predicate uses -- see `saturation_gap`, which rounds the other way
    for a reason.
    """
    if lam.raw <= 0:
        raise ValueError("a leverage must be positive")
    return Wad((constants.WAD * constants.WAD) // lam.raw)


def saturation_gap(lam: Wad) -> Wad:
    """The smallest gap at which `lambda |G| >= 1`, i.e. `ceil(1 / lambda)`.

    Rounded **up**, unlike `cap_for_leverage`, and the direction is load-bearing. This is the
    threshold, so it must be the smallest gap that saturates. `cap_for_leverage` is the reciprocal
    and rounds down; the two differ by one wei whenever `lambda` does not divide `1e36`, which is
    almost always. Using the rounded-down value as a threshold would place it a wei below the true
    crossing and make the saturation count disagree with the payoff.

    `ceil(a / b)` is written `(a + b - 1) // b` rather than imported from `math`, which would
    introduce a float conversion for a quantity that must stay exact.
    """
    if lam.raw <= 0:
        raise ValueError("a leverage must be positive")
    numerator = constants.WAD * constants.WAD
    return Wad((numerator + lam.raw - 1) // lam.raw)


def round_cap_up_to_lattice(cap: Wad, lattice: Wad) -> Wad:
    """Round a cap **up** to the grid.

    Up, not to nearest, and the direction is load-bearing: a larger cap is a smaller leverage, which
    saturates less often. Rounding to nearest would put half the published leverages on the unsafe
    side of the stated saturation probability, which is the one number the rule exists to control.
    """
    if lattice.raw <= 0:
        raise ValueError("a lattice spacing must be positive")
    steps = (cap.raw + lattice.raw - 1) // lattice.raw
    return Wad(steps * lattice.raw)


def lattice_leverage(raw_cap: Wad, lattice: Wad) -> Wad:
    """The published leverage: round the cap up to the grid, then floor the reciprocal.

    This is the rule that reproduces the paper's 16 / 18 / 19 for a 1% / 0.5% / 0.25% grid. It is
    the reason the grid has to be stated: the same measured quantile publishes three different
    leverages depending on a parameter the design originally left implicit.
    """
    return leverage_for_cap(round_cap_up_to_lattice(raw_cap, lattice))


def is_on_harmonic_ladder(lam: Wad) -> bool:
    """Whether a leverage is a whole number, i.e. its cap is exactly `1/n`.

    The harmonic ladder is the set of *traded* strikes. The rounding grid is not the ladder: it is
    the coarser set the cap is snapped to before the reciprocal is taken, and most of its points are
    not listable markets.
    """
    return lam.raw > 0 and lam.raw % constants.WAD == 0


def realised_saturation_rate(observations: Sequence[Wad], lam: Wad) -> Decimal:
    """The share of sessions on which `lambda |G| >= 1`.

    The rule's own validity check. Fed measured inputs it should return the stated `alpha`; fed the
    design's illustrative inputs it did not -- at the design's overnight leverage the session
    saturated on 2.74% of sessions against an advertised 1%, which is a safety error rather than a
    competitiveness one (paper §7.3).
    """
    if not observations:
        raise ValueError("a saturation rate needs at least one observation")
    threshold = saturation_gap(lam)
    saturated = sum(1 for observation in observations if observation.raw >= threshold.raw)
    return Decimal(saturated) / Decimal(len(observations))


def _ceiling(value: Decimal) -> int:
    """The smallest integer not less than `value`."""
    return int(value.to_integral_value(rounding=ROUND_CEILING))
