#!/usr/bin/env python3
"""Assert the brief's coverage requirements mechanically.

The brief states two for the contracts and one for the services. Until this script existed, `make
coverage` printed tables and left every verdict to the reader -- and for the contracts the reader
would have got it wrong, because `forge coverage`'s own `Total` row sums *every* instrumented
contract including the test helpers and mocks, so it reports a number several points below the
source tree's own. Both figures are true and only one of them answers the brief.

So this script answers the brief instead:

  Solidity
    1. Every `src/libraries/*.sol` must be 100% on lines, statements, branches and functions.
       All four, not just branches: the brief names branches, but a library at 100% branches and 80%
       lines has branches nobody reached.
    2. The source tree as a whole -- `src/**`, and nothing else -- must be at least 95% lines.

  Python
    3. Each service workspace must be at least 95% on `coverage.py`'s own measure, which counts
       branches. `bell_settlement.domain.ports` is the reason the two services need the same bar as
       the contracts rather than a lower one: a `Protocol` body is a declaration, and a declaration
       nothing imports is a boundary nobody has checked.

Exit status is non-zero if any rule fails, so `make check` fails with it.

Usage:
    tools/check_coverage.py                # runs everything
    tools/check_coverage.py --solidity     # contracts only
    tools/check_coverage.py --python       # services only
    tools/check_coverage.py --from FILE    # parse a saved forge report instead of running it
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = REPO_ROOT / "contracts"

#: The bar the brief sets for `contracts/src/libraries/`.
LIBRARY_REQUIRED_PERCENT = 100.0
#: The bar the brief sets overall, applied to `src/**` rather than to `forge`'s Total row.
SOURCE_REQUIRED_PERCENT = 95.0
#: The bar for each Python workspace, on `coverage.py`'s combined line-and-branch measure.
PYTHON_REQUIRED_PERCENT = 95.0

#: Each Python workspace: its directory, the package to measure, and the tests to run.
PYTHON_WORKSPACES: tuple[tuple[str, str], ...] = (
    ("calibrator", "bell_calibrator"),
    ("settlement", "bell_settlement"),
)

#: `| src/libraries/Amm.sol | 100.00% (31/31) | ... | ... | ... |`
ROW = re.compile(r"^\|\s*(?P<path>\S+\.sol)\s*\|(?P<cells>.+)\|\s*$")
#: A single `100.00% (31/31)` cell.
CELL = re.compile(r"(?P<pct>[\d.]+)%\s*\((?P<hit>\d+)/(?P<total>\d+)\)")

COLUMNS = ("lines", "statements", "branches", "functions")


@dataclass(frozen=True)
class Coverage:
    """One file's coverage, as four (hit, total) pairs."""

    path: str
    counts: dict[str, tuple[int, int]]

    def percent(self, column: str) -> float:
        hit, total = self.counts[column]
        # A file with nothing to cover is fully covered; `forge` prints `N/A (0/0)` for these.
        return 100.0 if total == 0 else 100.0 * hit / total

    def is_perfect(self) -> bool:
        return all(self.percent(column) == 100.0 for column in COLUMNS)


def parse(report: str) -> list[Coverage]:
    """Every source row in a `forge coverage --report summary` table."""
    found: list[Coverage] = []
    for line in report.splitlines():
        row = ROW.match(line)
        if row is None:
            continue
        path = row.group("path")
        if not path.startswith("src/"):
            continue
        cells = CELL.findall(row.group("cells"))
        if len(cells) != len(COLUMNS):
            continue
        counts = {
            column: (int(cells[index][1]), int(cells[index][2]))
            for index, column in enumerate(COLUMNS)
        }
        found.append(Coverage(path=path, counts=counts))
    return found


def run_forge() -> str:
    """Run `forge coverage` and return its output."""
    result = subprocess.run(
        ["forge", "coverage", "--report", "summary"],
        cwd=CONTRACTS,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write("forge coverage failed:\n")
        sys.stderr.write(result.stdout[-4000:])
        sys.stderr.write(result.stderr[-4000:])
        raise SystemExit(1)
    return result.stdout


def check_libraries(files: list[Coverage], report: list[str]) -> None:
    """Requirement 1: every library is perfect on all four metrics."""
    libraries = [f for f in files if f.path.startswith("src/libraries/")]
    if not libraries:
        report.append("  no files under src/libraries/; the rule was not applied to anything")
        return
    for library in sorted(libraries, key=lambda f: f.path):
        if library.is_perfect():
            continue
        misses = [
            f"{column} {library.percent(column):.2f}%"
            f" ({library.counts[column][0]}/{library.counts[column][1]})"
            for column in COLUMNS
            if library.percent(column) != LIBRARY_REQUIRED_PERCENT
        ]
        report.append(f"  {library.path}: {', '.join(misses)}")


def check_source_total(files: list[Coverage], report: list[str]) -> float:
    """Requirement 2: `src/**` as a whole is at least 95% lines."""
    hit = sum(f.counts["lines"][0] for f in files)
    total = sum(f.counts["lines"][1] for f in files)
    if total == 0:
        report.append("  no source lines instrumented")
        return 0.0
    percent = 100.0 * hit / total
    if percent < SOURCE_REQUIRED_PERCENT:
        report.append(
            f"  src/** lines {percent:.2f}% ({hit}/{total}); "
            f"the brief requires {SOURCE_REQUIRED_PERCENT:.0f}%"
        )
    return percent


def measure_python(workspace: str, package: str) -> tuple[float, int, int]:
    """Run one workspace's tests under `coverage.py` and return `(percent, covered, total)`.

    `coverage.py` is invoked through `pytest-cov` so the measurement is the one the project already
    produces, rather than a second opinion that could disagree with `make coverage`.
    """
    with tempfile.TemporaryDirectory() as scratch:
        destination = Path(scratch) / "coverage.json"
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "pytest",
                "tests",
                "-q",
                f"--cov={package}",
                "--cov-report=json:" + str(destination),
                "--cov-report=",  # no terminal table; this script is the report
            ],
            cwd=REPO_ROOT / workspace,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            sys.stderr.write(f"{workspace}: pytest failed\n")
            sys.stderr.write(result.stdout[-3000:])
            sys.stderr.write(result.stderr[-3000:])
            raise SystemExit(1)
        if not destination.exists():
            sys.stderr.write(
                f"{workspace}: no coverage JSON was written. Is `pytest-cov` installed?\n"
                "It is declared in the workspace's `dev` extra; run `make venv`.\n"
            )
            raise SystemExit(1)
        totals: dict[str, float] = json.loads(destination.read_text())["totals"]

    return (
        float(totals["percent_covered"]),
        int(totals["covered_lines"]),
        int(totals["num_statements"]),
    )


def check_python(report: list[str], required: float) -> list[str]:
    """Requirement 3: each service workspace is at least `required` percent, branches included."""
    summaries: list[str] = []
    for workspace, package in PYTHON_WORKSPACES:
        percent, covered, total = measure_python(workspace, package)
        summaries.append(f"{workspace} {percent:.2f}%")
        if percent < required:
            report.append(
                f"  {workspace}: {percent:.2f}% ({covered}/{total} statements); "
                # `:g`, not `:.0f`: a fractional override would round to a different number than the
                # one being applied, and a message that misstates its own rule is worse than none.
                f"requires {required:g}%"
            )
    return summaries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--from",
        dest="source",
        type=Path,
        default=None,
        help="parse a saved forge report instead of running forge",
    )
    parser.add_argument(
        "--solidity", action="store_true", help="check the contracts only"
    )
    parser.add_argument("--python", action="store_true", help="check the services only")
    parser.add_argument(
        "--python-threshold",
        type=float,
        default=PYTHON_REQUIRED_PERCENT,
        help=f"override the service bar (default {PYTHON_REQUIRED_PERCENT:.0f}%)",
    )
    arguments = parser.parse_args()
    # Neither flag means both; either flag means only that one.
    check_sol = arguments.solidity or not arguments.python
    check_py = arguments.python or not arguments.solidity

    failures: list[str] = []
    summary: list[str] = []

    if check_sol:
        report_text = (
            arguments.source.read_text() if arguments.source is not None else run_forge()
        )
        files = parse(report_text)
        if not files:
            sys.stderr.write(
                "check_coverage: no source rows found in the coverage report.\n"
                "The table format may have changed; the report was:\n"
            )
            sys.stderr.write(report_text[-2000:])
            return 1
        check_libraries(files, failures)
        source_percent = check_source_total(files, failures)
        library_count = sum(1 for f in files if f.path.startswith("src/libraries/"))
        summary.append(
            f"{library_count} libraries at 100% on all four metrics, "
            f"src/** at {source_percent:.2f}% lines"
        )

    if check_py:
        summary.extend(check_python(failures, arguments.python_threshold))

    if failures:
        print(f"check_coverage: {len(failures)} violation(s)", file=sys.stderr)
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    print(f"check_coverage: all checks passed ({'; '.join(summary)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
