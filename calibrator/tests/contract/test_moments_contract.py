"""The pricing primitive, checked against the shared differential fixture.

The counterpart is `contracts/test/differential/Moments.t.sol`. The values in
`spec/fixtures/moments.json` were produced by this same module, so what this file establishes is
that the reference is *reproducible* -- that regenerating it from the current code yields the
committed numbers. That is the half of the contract the Solidity test cannot check, because it has
no way to know what the reference ought to be.

The other half -- whether the on-chain approximation agrees with this reference inside the derived
tolerance -- belongs to the Solidity test, and is asserted there.
"""

from __future__ import annotations

import json
from decimal import ROUND_HALF_EVEN, Decimal
from pathlib import Path
from typing import Any

from bell_calibrator.domain import moments

FIXTURE = Path(__file__).resolve().parents[3] / "spec" / "fixtures" / "moments.json"

WAD = Decimal(10) ** 18


def quantise(value: Decimal) -> int:
    return int((value * WAD).to_integral_value(rounding=ROUND_HALF_EVEN))


def load_points() -> list[dict[str, Any]]:
    payload: dict[str, Any] = json.loads(FIXTURE.read_text())
    points: list[dict[str, Any]] = payload["points"]
    assert len(points) == payload["pointCount"]
    return points


def test_reference_is_reproducible_from_the_current_code() -> None:
    for point in load_points():
        lam = Decimal(point["lambdaWad"]) / WAD
        sigma = Decimal(point["sigmaWad"]) / WAD
        moment = moments.truncated_abs_moment(lam, Decimal(0), sigma)
        assert quantise(moment) == point["momentWad"], point
        assert quantise(lam * moment) == point["premiumWad"], point


def test_first_moment_is_reproducible_from_the_current_code() -> None:
    for point in load_points():
        lam = Decimal(point["lambdaWad"]) / WAD
        sigma = Decimal(point["sigmaWad"]) / WAD
        assert quantise(moments.truncated_first_moment(lam, sigma)) == point["firstMomentWad"]


def test_the_fixture_spans_the_listed_leverage_range() -> None:
    # The canonical set runs 10 to 32 and the event set 4 to 21; the fixture must cover both with
    # room either side, or the differential test would not be exercising the range the protocol
    # actually lists.
    leverages = sorted({point["lambdaWad"] // 10**18 for point in load_points()})
    assert min(leverages) <= 4
    assert max(leverages) >= 32
    for published in (10, 11, 15, 16, 22, 32):
        assert published in leverages


def test_tolerance_is_derived_not_chosen() -> None:
    # The fixture records the tolerance per point, and it must equal cap * 1.5e-7 + the WAD slack.
    # Re-deriving it here is the check that nobody quietly widened it to make a test pass.
    erf_bound = Decimal("1.5e-7")
    for point in load_points():
        cap = Decimal(point["capWad"]) / WAD
        expected = int(cap * erf_bound * WAD) + 1_000
        assert point["toleranceWei"] == expected, point
