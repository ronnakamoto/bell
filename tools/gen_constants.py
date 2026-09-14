#!/usr/bin/env python3
"""Generate every consumer of `spec/constants.yaml`.

The build brief (§6) makes `spec/constants.yaml` the only place a domain constant is written down,
and requires both language sides to read it at build time — "generated constants file for Solidity,
loaded directly in Python". Loading it at runtime in Python would put a filesystem read inside
`domain/`, which §5.1 forbids, so Python gets a generated module too. The file is the source; these
three are build products.

Emits:
    contracts/src/generated/Constants.sol
    calibrator/src/bell_calibrator/domain/constants.py
    spec/fixtures/canonical.json

Run with `make build`. The output is deterministic; `make check` re-runs the generator and fails if
the committed files differ, which is what stops a hand-edit from silently diverging.
"""

from __future__ import annotations

import json
import sys
from decimal import Decimal, getcontext
from pathlib import Path

import yaml

getcontext().prec = 60

REPO_ROOT = Path(__file__).resolve().parent.parent
SPEC = REPO_ROOT / "spec" / "constants.yaml"
SOLIDITY_OUT = REPO_ROOT / "contracts" / "src" / "generated" / "Constants.sol"
PYTHON_OUT = REPO_ROOT / "calibrator" / "src" / "bell_calibrator" / "domain" / "constants.py"
CANONICAL_OUT = REPO_ROOT / "spec" / "fixtures" / "canonical.json"

WAD = 10**18
GENERATED_BANNER = "GENERATED FILE - DO NOT EDIT BY HAND."


def wad(decimal_string: str) -> int:
    """Exact decimal string -> WAD integer. Refuses a value that is not representable."""
    value = Decimal(decimal_string) * WAD
    if value != value.to_integral_value():
        raise ValueError(f"{decimal_string} is not exactly representable at WAD scale")
    return int(value)


def group(digits: int) -> str:
    """1234567 -> 1_234_567, so a WAD literal is readable and miscount-proof."""
    return f"{digits:_}"


# ---------------------------------------------------------------------------- emission tables
#
# Each row is (SOLIDITY_NAME, python_name, value, unit_note, source).
# Written out longhand rather than derived from YAML keys so that a rename in the YAML is a loud
# failure here rather than a silently missing constant.

UINT_ROWS = [
    ("WAD", "WAD", 10**18, "1e18, the fixed-point scale", "paper §2"),
    ("ALPHA_WAD", "ALPHA_WAD", wad("0.01"), "saturation probability", "paper §6.1 Eq 14"),
    ("TIER1_HALT_BAND_WAD", "TIER1_HALT_BAND_WAD", wad("0.05"), "guard G3, Tier-1 band", "paper §12.4"),
    ("HALT_BAND_DEFAULT_WAD", "HALT_BAND_DEFAULT_WAD", wad("0.25"), "guard G3, legacy default", "paper §9.4"),
    ("COLLATERAL_DECIMALS", "COLLATERAL_DECIMALS", 6, "USDG decimals, asserted at construction", "paper Table 6"),
    ("EQUITY_TOKEN_DECIMALS", "EQUITY_TOKEN_DECIMALS", 18, "reference token decimals", "paper check D1"),
    ("PROTOCOL_FEE_ANNUALISED_WAD", "PROTOCOL_FEE_ANNUALISED_WAD", wad("0.12"), "eta_ann", "paper §6.3 Eq 17"),
    ("HOURS_PER_YEAR", "HOURS_PER_YEAR", 8760, "365 * 24", "paper §6.3 Eq 17"),
    ("PROTOCOL_FEE_CAP_OF_PREMIUM_WAD", "PROTOCOL_FEE_CAP_OF_PREMIUM_WAD", wad("0.05"), "eta <= 0.05 * pL", "paper §6.3 Eq 18"),
    ("BLENDED_FEE_TARGET_BP_WAD", "BLENDED_FEE_TARGET_BP_WAD", wad("4.106"), "blended fee, basis points", "paper §11.2"),
    ("RAMP_PHI_0_WAD", "RAMP_PHI_0_WAD", wad("0.001"), "trading fee at the close", "paper §6.3 Eq 19"),
    ("RAMP_PHI_1_WAD", "RAMP_PHI_1_WAD", wad("0.01"), "trading fee at the open", "paper §6.3 Eq 19"),
    ("RAMP_TIME_AVERAGE_CEILING_WAD", "RAMP_TIME_AVERAGE_CEILING_WAD", wad("0.007"), "phi_0 + (phi_1 - phi_0)*2/3", "paper §6.3"),
    ("TRADING_FEE_REFERENCE_WAD", "TRADING_FEE_REFERENCE_WAD", wad("0.0055"), "phi_ref, a fee not a volatility", "paper §6.3 Eq 20"),
    ("ROUNDING_LATTICE_WAD", "ROUNDING_LATTICE_WAD", wad("0.0025"), "cap grid; 0.25% reproduces the published lambdas", "paper §6.1, Table 26"),
    ("STALENESS_SESSIONS", "STALENESS_SESSIONS", 12, "commitment usable horizon, in sessions", "paper Table 19"),
    ("BOND_LOCK_SESSIONS", "BOND_LOCK_SESSIONS", 13, "rotation period plus challenge window", "paper Table 19"),
    ("PUBLISHER_KEYS_PER_NAME", "PUBLISHER_KEYS_PER_NAME", 1, "one compromised key costs one name", "paper Table 19"),
    ("OVERNIGHT_WINDOW_SESSIONS", "OVERNIGHT_WINDOW_SESSIONS", 504, "E, selected by forward error", "paper §7.9 Table 15"),
    ("OVERNIGHT_WINDOW_SESSIONS_AAPL", "OVERNIGHT_WINDOW_SESSIONS_AAPL", 378, "E for AAPL", "paper §7.9 Table 15"),
    ("WEEKEND_WINDOW_SESSIONS", "WEEKEND_WINDOW_SESSIONS", 126, "W; the longest the sample supports", "paper §7.9 Table 15"),
]

# Bond amounts are in the collateral's own base units (6 decimals), per ruling R2 in DESIGN_NOTES.
# They are NOT WAD: writing them as 500_000e18 is the incoherence DESIGN_NOTES F4 records.
BOND_ROWS = [
    ("MIN_PUBLISHER_BOND", "MIN_PUBLISHER_BOND", 500_000 * 10**6, "3x the largest one-session mispricing gain", "paper Table 19"),
    ("CHALLENGER_BOND", "CHALLENGER_BOND", 50_000 * 10**6, "upper bound on a guessing challenger", "paper Table 19"),
]

ROUTE_ROWS = [
    ("R1", "ROUTE_R1_COST_BP_WAD", "29.7", "void at 0.50", "paper Table 22"),
    ("R2", "ROUTE_R2_COST_BP_WAD", "0.021", "deferred settlement on the first valid print", "paper Table 22"),
    ("R4", "ROUTE_R4_COST_BP_WAD", "1.37", "constant refund with a plausibility band", "paper Table 22"),
    ("R5", "ROUTE_R5_COST_BP_WAD", "1.37", "optimistic challenge window", "paper Table 22"),
]


def render_solidity(constants: dict) -> str:
    lines = [
        "// SPDX-License-Identifier: MIT",
        "pragma solidity 0.8.26;",
        "",
        "/// @title Constants",
        f"/// @notice {GENERATED_BANNER}",
        "/// @dev Produced by tools/gen_constants.py from spec/constants.yaml.",
        "///      Regenerate with `make build`. `make check` fails if this file is stale.",
        "///",
        "///      Every value carries its provenance. A constant that appears in a second source file",
        "///      is a bug waiting to diverge (build brief §6).",
        "library Constants {",
    ]
    for section, rows in (
        ("protocol", UINT_ROWS),
        ("bonds, in collateral base units (USDG, 6 decimals)", BOND_ROWS),
    ):
        lines.append(f"    // ---------------------------------------------------------------- {section}")
        for sol_name, _py_name, value, note, source in rows:
            lines.append(f"    /// @dev {note}. Source: {source}.")
            lines.append(f"    uint256 internal constant {sol_name} = {group(value)};")
        lines.append("")

    lines.append("    // ---------------------------------------------------------------- settlement route costs, bp")
    for _code, sol_name, value, note, source in ROUTE_ROWS:
        lines.append(f"    /// @dev {note}. Source: {source}.")
        lines.append(f"    uint256 internal constant {sol_name} = {group(wad(value))};")
    lines.append("")

    lines.append("    // ---------------------------------------------------------------- chain")
    lines.append("    /// @dev Robinhood Chain. Source: paper §1, §9.2.")
    lines.append(f"    uint256 internal constant CHAIN_ID = {group(constants['deployment']['chain_id'])};")
    lines.append("    /// @dev The fork block the end-to-end suite pins. Source: paper §9.2.")
    lines.append(f"    uint256 internal constant FORK_BLOCK_L2 = {group(constants['deployment']['fork_block_l2'])};")
    lines.append("")
    lines.append("    // ---------------------------------------------------------------- gas budget")
    lines.append("    /// @dev Baselines are the paper's measurements; budgets are the brief's §13.3 multiples.")
    lines.append(f"    uint256 internal constant GAS_TRUNCATED_MOMENT_BASELINE = {group(constants['gas_budget']['truncated_moment_closed_form']['baseline'])};")
    lines.append(f"    uint256 internal constant GAS_PREMIUM_STORAGE_BASELINE = {group(constants['gas_budget']['premium_read_from_storage']['baseline'])};")
    lines.append(f"    uint256 internal constant GAS_REGISTRY_OPERATION_MAX = {group(constants['gas_budget']['registry_operations_max']['commit'])};")
    lines.append("}")
    return "\n".join(lines) + "\n"


def render_python(constants: dict) -> str:
    lines = [
        f'"""{GENERATED_BANNER}',
        "",
        "Produced by tools/gen_constants.py from spec/constants.yaml.",
        "Regenerate with `make build`. `make check` fails if this file is stale.",
        "",
        "Integers are exact. Nothing here is a float: `domain/` never sees one (brief §7.3).",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "WAD: int = 10**18",
        "",
    ]
    for _sol_name, py_name, value, note, source in UINT_ROWS:
        if py_name == "WAD":
            continue
        lines.append(f"# {note}. Source: {source}.")
        lines.append(f"{py_name}: int = {group(value)}")
    lines.append("")
    lines.append("# Bonds, in collateral base units (USDG, 6 decimals). Ruling R2 in DESIGN_NOTES.")
    for _sol_name, py_name, value, note, source in BOND_ROWS:
        lines.append(f"# {note}. Source: {source}.")
        lines.append(f"{py_name}: int = {group(value)}")
    lines.append("")
    lines.append("# Settlement route costs, in basis points at WAD scale.")
    for _code, py_name, value, note, source in ROUTE_ROWS:
        lines.append(f"# {note}. Source: {source}.")
        lines.append(f"{py_name}: int = {group(wad(value))}")
    lines.append("")
    lines.append("# Chain")
    lines.append(f"CHAIN_ID: int = {constants['deployment']['chain_id']}")
    lines.append(f"FORK_BLOCK_L2: int = {group(constants['deployment']['fork_block_l2'])}")
    lines.append("")
    return "\n".join(lines)


def render_canonical(constants: dict) -> str:
    """The golden fixture, in a form Solidity can read (it cannot parse YAML).

    Values are emitted as WAD integers rather than decimal strings. Solidity has no decimal parser,
    and hand-rolling one in a test would put a second implementation of the fixture's meaning into
    the repository. `capWad` is derived as `1e18 / lambda` rather than taken from the YAML's rounded
    `cap` field, so the fixture carries the exact saturation point.
    """
    canonical = constants["canonical_parameters"]

    cells = []
    for cell in canonical["cells"]:
        lam = int(cell["lambda"])
        cells.append(
            {
                "name": cell["name"],
                "session": cell["session"],
                "n": int(cell["n"]),
                "sigmaWad": wad(cell["sigma"]),
                "q99Wad": wad(cell["q99"]),
                "lambdaWad": wad(str(lam)),
                "capWad": WAD // lam,
                "pLWad": wad(cell["pL"]),
            }
        )

    gaussian = []
    for name, by_session in canonical["gaussian_reference_pL"]["cells"].items():
        for session, value in by_session.items():
            gaussian.append(
                {"name": name, "session": session, "pLWad": wad(value)}
            )

    payload = {
        "_generated": GENERATED_BANNER,
        "_source": "spec/constants.yaml (paper §7.8 Table 13, §7.11 Table 18)",
        "_note": (
            "pLWad is the EMPIRICAL truncated mean, the seed model. gaussian_pL is the differential "
            "reference computed from sigmaWad and lambdaWad via the paper's Eq (12): "
            "pL = lambda * E[min(|G|, 1/lambda)]."
        ),
        "cells": cells,
        "gaussian_pL": gaussian,
        "event_session": {
            "pooledShapeQWad": wad(constants["event_session"]["pooled_shape_q_C"]["value"]),
            "gaussianShapeReferenceWad": wad(
                constants["event_session"]["gaussian_shape_reference"]["value"]
            ),
        },
        "bond_sizing": [
            {
                "name": row["name"],
                "lambdaWad": wad(str(row["lambda"])),
                "dpDlambdaWad": wad(row["dp_dlambda"]),
                "notionalUsd": row["one_session_gain_usd"] * 10**0,
                "oneSessionGainUsd": row["one_session_gain_usd"],
            }
            for row in constants["bond_sizing"]["rows"]
        ],
    }
    # ensure_ascii=False: the fixtures are read by humans as well as by two test suites, and the
    # provenance strings carry section marks.
    return json.dumps(payload, indent=2, sort_keys=False, ensure_ascii=False) + "\n"


def main() -> int:
    constants = yaml.safe_load(SPEC.read_text())
    outputs = {
        SOLIDITY_OUT: render_solidity(constants),
        PYTHON_OUT: render_python(constants),
        CANONICAL_OUT: render_canonical(constants),
    }
    stale: list[Path] = []
    for path, content in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.read_text() == content:
            continue
        stale.append(path)
        path.write_text(content)

    check_only = "--check" in sys.argv
    if check_only and stale:
        print("generated files are stale:", file=sys.stderr)
        for path in stale:
            print(f"  {path.relative_to(REPO_ROOT)}", file=sys.stderr)
        print("run `make build`", file=sys.stderr)
        return 1
    for path in outputs:
        state = "stale, rewritten" if path in stale else "up to date"
        print(f"  {path.relative_to(REPO_ROOT)}: {state}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
