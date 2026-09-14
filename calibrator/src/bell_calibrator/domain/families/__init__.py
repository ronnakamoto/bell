"""The family registry.

Two families are implemented and two are named in the paper without an implementation; the gap is
recorded rather than hidden:

- **empirical** -- the seed model, and the reference every other family is scored against.
- **gaussian** -- implemented so that the brief's rejection of it is re-measurable rather than
  asserted.
- **student-t, normal-inverse-Gaussian, Merton jump-diffusion** -- named in the paper's Table 18,
  which reports each one's premium error against the empirical distribution. Not implemented here.
  The Student-t and Merton families need only `math.lgamma` and a Poisson sum; the NIG needs a
  modified Bessel function of the second kind, which is a numerical routine that belongs in an
  adapter rather than in `domain/`. The family question -- whether NIG is the production model or a
  fallback for thin samples -- is open as F10 in DESIGN_NOTES.md; implementing a family whose role
  is undecided would fix the answer by accident.

`SEED_FAMILY` is the one the brief names, looked up rather than written as a literal at each
call site so that "which model produced this parameter set" has one answer.
"""

from __future__ import annotations

from collections.abc import Mapping

from bell_calibrator.domain.families.base import DistributionFamily, FamilyFit, GapSample
from bell_calibrator.domain.families.empirical import EmpiricalTruncatedFamily
from bell_calibrator.domain.families.gaussian import GaussianFamily, gaussian_premium_wad

#: Every implemented family, by name.
FAMILIES: Mapping[str, DistributionFamily] = {
    "empirical": EmpiricalTruncatedFamily(),
    "gaussian": GaussianFamily(),
}

#: The seed model, per the brief's §4.2.4.
SEED_FAMILY = "empirical"

#: The families the paper compares and this repository does not implement. Named rather than omitted
#: so that a caller asking for one gets a specific refusal instead of a missing key.
UNIMPLEMENTED_FAMILIES: frozenset[str] = frozenset({"student_t", "nig", "merton"})


def family_for(name: str) -> DistributionFamily:
    """The family with this name.

    Raises a specific error for a family the paper names but this repository does not implement,
    rather than a `KeyError`. The distinction matters: a missing key reads as a typo, whereas the
    of NIG is a decision recorded in DESIGN_NOTES.md rather than an oversight.
    """
    if name in UNIMPLEMENTED_FAMILIES:
        raise NotImplementedError(
            f"the {name!r} family is named in the paper but not implemented here; see "
            f"DESIGN_NOTES.md F10"
        )
    return FAMILIES[name]


def seed_family() -> DistributionFamily:
    """The family the brief names as the seed."""
    return FAMILIES[SEED_FAMILY]


__all__ = [
    "FAMILIES",
    "SEED_FAMILY",
    "UNIMPLEMENTED_FAMILIES",
    "DistributionFamily",
    "FamilyFit",
    "GapSample",
    "family_for",
    "gaussian_premium_wad",
    "seed_family",
]
