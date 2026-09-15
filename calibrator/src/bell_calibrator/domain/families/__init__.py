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
  adapter rather than in `domain/`. F10 is closed: the paper is primary, so NIG is the documented
  fallback for thin samples, not the production model. The family is still missing — that is
  tracker G0, a P0 gate, not an open question.
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

#: The seed model, per paper §5.3 / Table 31 P0. The brief's §4.2.4 agrees on the seed.
SEED_FAMILY = "empirical"

#: The families the paper compares and this repository does not implement. Named rather than omitted
#: so that a caller asking for one gets a specific refusal instead of a missing key.
UNIMPLEMENTED_FAMILIES: frozenset[str] = frozenset({"student_t", "nig", "merton"})


def family_for(name: str) -> DistributionFamily:
    """The family with this name.

    Raises a specific error for a family the paper names but this repository does not implement,
    rather than a `KeyError`. A missing key reads as a typo; the absence of NIG is F10 (closed)
    and tracker G0, and the error has to say so.
    """
    if name in UNIMPLEMENTED_FAMILIES:
        raise NotImplementedError(
            f"the {name!r} family is named in the paper but not implemented here; see "
            f"DESIGN_NOTES.md F10 (closed: fallback, not production) and tracker G0"
        )
    return FAMILIES[name]


def seed_family() -> DistributionFamily:
    """The family the paper names as the seed: the empirical truncated distribution."""
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
