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


def render() -> tuple[str, int]:
    """The fixture's text, and its point count.

    Split out of `main` so `--check` can compare without writing, which is the pattern
    `gen_constants.py` already uses. Without it the pair of generators cannot be gated: running the
    Python one to see whether it agrees would rewrite the file, so "both agree" would be a one-off
    observation rather than a check. See DESIGN_NOTES.md F72.
    """
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
                        # **Every integer field is a string, and the rule is uniform on purpose.**
                        #
                        # A JSON number is exact only up to 2^53 - 1. These are WAD-scale values, so
                        # most of them exceed that: `lambdaWad` at 1e21 for the widest leverage,
                        # `premiumWad` at ~9.9e17, and 109 of the 112 points have at least one field
                        # over the line. A JavaScript reader does not fail on them -- `JSON.parse`
                        # silently rounds, so the port would compare a wrong number against a
                        # tolerance and either pass by luck or fail confusingly.
                        #
                        # `toleranceWei` cannot exceed 2^53 today (its maximum is about 1.5e11), and
                        # it is still emitted as a string. A uniform rule -- "every integer in this
                        # fixture is a string" -- is checkable by reading one line; a per-field rule
                        # requires re-deriving the bound every time a field is added. See
                        # DESIGN_NOTES.md F52.
                        "lambdaWad": str(lam_units * WAD),
                        "sigmaWad": str(to_wad(sigma)),
                        "capWad": str(to_wad(cap)),
                        "momentWad": str(to_wad(moment)),
                        "premiumWad": str(to_wad(premium)),
                        "firstMomentWad": str(to_wad(first_moment)),
                        "toleranceWei": str(tolerance_wei),
                    }
                )

    payload = {
        "_generated": "GENERATED FILE - DO NOT EDIT BY HAND.",
        # Names the derivation, not the generator file. `tools/gen_moments_fixture.ts` writes this
        # fixture too, and `make check-generated` runs both and requires them to agree byte for byte,
        # so a banner naming one of them is false whenever the other ran. The values are unchanged;
        # see DESIGN_NOTES.md F72.
        "_source": "domain/moments, evaluated at 50 significant digits (paper Eq (12))",
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
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n", len(points)


def main() -> int:
    """Write the fixture, or with `--check` report whether the committed one is stale."""
    content, point_count = render()
    OUT.parent.mkdir(parents=True, exist_ok=True)

    stale = not OUT.exists() or OUT.read_text() != content
    if stale:
        OUT.write_text(content)

    if "--check" in sys.argv and stale:
        print("generated files are stale:", file=sys.stderr)
        print(f"  {OUT.relative_to(REPO_ROOT)}", file=sys.stderr)
        print("run `make build`", file=sys.stderr)
        return 1
    state = "stale, rewritten" if stale else "up to date"
    print(f"  {OUT.relative_to(REPO_ROOT)}: {state}, {point_count} points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
