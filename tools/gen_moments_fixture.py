#!/usr/bin/env python3
"""Generate `spec/fixtures/moments.json`, the differential fixture for the pricing primitive.

Paper §10.4 makes this the critical cross-language test: "For every formula that exists in both
Solidity and Python, there must be a test that reads a shared JSON fixture from `spec/` and asserts
the two implementations agree to a stated tolerance. The truncated moment is the critical one."

The values here are computed by `bell_calibrator.domain.moments`, which evaluates the error function
to 50 significant digits. The Solidity implementation uses Abramowitz & Stegun 7.1.26, whose stated
absolute error is 1.5e-7. The *difference* between the two is therefore the on-chain approximation's
error and nothing else -- which is what makes the tolerance derivable rather than chosen.

Tolerance derivation, stated once here and asserted in both consumers:

    The moment's tail term is 2c * (1 - Phi(c/sigma)), and Phi = (1 + erf)/2, so Phi inherits half
    of erf's absolute error, and the tail inherits 2c * (1.5e-7 / 2) = c * 1.5e-7.
    The body term uses the density, which is accurate to WAD rounding (~1e-18 relative) and is
    negligible beside it. WAD quantization contributes at most a few wei.
    So: absolute_tolerance = c * 1.5e-7 + a small WAD slack.

The fixture records `toleranceWei` per point so that neither consumer re-derives it independently --
a second derivation is a second source of truth.

Run with `make build`. Deterministic.
"""

from __future__ import annotations

import json
import sys
from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT = REPO_ROOT / "spec" / "fixtures" / "moments.json"
CALIBRATOR_SRC = REPO_ROOT / "calibrator" / "src"

sys.path.insert(0, str(CALIBRATOR_SRC))

from bell_calibrator.domain import moments  # noqa: E402

WAD = 10**18
ERF_ABSOLUTE_BOUND = Decimal("1.5e-7")
WAD_SLACK_WEI = 1_000

# A grid rather than a handful of points. It spans the leverage range the protocol lists (the
# canonical set runs 10 to 32, the event set 4 to 21, and the ladder is open above that) and the
# volatility range the measured cross-section spans (AAPL overnight at 1.09% to COIN at 3.13%, with
# room either side).
LEVERAGES = [1, 2, 4, 8, 10, 11, 15, 16, 22, 32, 64, 100, 250, 1000]
SIGMAS = ["0.0050", "0.0109", "0.0145", "0.0188", "0.0218", "0.0257", "0.0313", "0.0500"]


def to_wad(value: Decimal) -> int:
    """Quantise to the WAD grid, half-even.

    The reference is computed at 50 significant digits and the WAD grid has 18 decimal places, so a
    quantisation is unavoidable. It costs at most half a wei, which is eleven orders of magnitude
    below the 1.5e-7 tolerance the fixture is used to assert, so it cannot contribute to a failure.
    """
    return int((value * WAD).to_integral_value(rounding=ROUND_HALF_EVEN))


def main() -> int:
    points = []
    with localcontext() as context:
        context.prec = 60
        for lam_units in LEVERAGES:
            lam = Decimal(lam_units)
            cap = 1 / lam
            for sigma_text in SIGMAS:
                sigma = Decimal(sigma_text)
                moment = moments.truncated_abs_moment(lam, Decimal(0), sigma)
                premium = lam * moment
                first_moment = moments.truncated_first_moment(lam, sigma)
                tolerance_wei = int(cap * ERF_ABSOLUTE_BOUND * WAD) + WAD_SLACK_WEI
                points.append(
                    {
                        "lambdaWad": lam_units * WAD,
                        "sigmaWad": to_wad(sigma),
                        "capWad": to_wad(cap),
                        "momentWad": to_wad(moment),
                        "premiumWad": to_wad(premium),
                        "firstMomentWad": to_wad(first_moment),
                        "toleranceWei": tolerance_wei,
                    }
                )

    payload = {
        "_generated": "GENERATED FILE - DO NOT EDIT BY HAND.",
        "_source": "tools/gen_moments_fixture.py (bell_calibrator.domain.moments, 50 digits)",
        "_identity": (
            "paper Eq (12): E[min(|G|, c)] = 2*sigma*(phi(0) - phi(c/sigma)) "
            "+ 2*c*(1 - Phi(c/sigma)), with c = 1/lambda and pL = lambda * E[min(|G|, c)]"
        ),
        "_tolerance": (
            "absoluteTolerance = capWad * 1.5e-7 + 1000 wei. Derived from the on-chain error "
            "function's stated bound of 1.5e-7, not chosen. Recorded per point."
        ),
        "pointCount": len(points),
        "points": points,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    print(f"  {OUT.relative_to(REPO_ROOT)}: written, {len(points)} points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
