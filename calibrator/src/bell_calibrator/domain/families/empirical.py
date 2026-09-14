"""The empirical truncated distribution: the seed model.

The paper's §5.3 makes this the primary model and the brief's §4.2.4 makes it the seed, and the
reason is that it assumes nothing. Every fitted family is scored against this one -- the Gaussian
prices the overnight premium 29 to 42% rich *relative to it*, the NIG closes to within 2.4% *of it*
-- so the reference has to be the measurement rather than another model.

The estimator is `E[min(|G|, c)]` computed on the raw gaps, with `c = 1/lambda` the saturation
point.
Computed on the raw gaps and not on pre-truncated values: a sample whose values were already capped
cannot recover the mass above the cap, and the whole reason the cap matters is that the payoff stops
growing there.
"""

from __future__ import annotations

from bell_calibrator.domain.constants import WAD
from bell_calibrator.domain.families.base import (
    FamilyFit,
    GapSample,
    premium_from_truncated_mean,
    truncated_mean_wad,
)


class EmpiricalTruncatedFamily:
    """The seed model: the truncated mean taken directly from the sample."""

    @property
    def name(self) -> str:
        return "empirical"

    @property
    def is_seed_model(self) -> bool:
        return True

    def premium_wad(self, lam_wad: int, sample: GapSample) -> int:
        cap_wad = (WAD * WAD) // lam_wad
        return premium_from_truncated_mean(lam_wad, truncated_mean_wad(sample, cap_wad))

    def fit(self, lam_wad: int, sample: GapSample) -> FamilyFit:
        return FamilyFit(
            family=self.name,
            lam_wad=lam_wad,
            premium_wad=self.premium_wad(lam_wad, sample),
            observations=sample.count,
        )
