#!/usr/bin/env python3
"""Assert the brief's coverage requirements mechanically.

The brief states two: 100% branch coverage on `contracts/src/libraries/`, and at least 95%
overall. Until this script existed, `make coverage` printed a table and left the verdict to the
reader -- and the reader would have got it wrong, because `forge coverage`'s own `Total` row sums
*every* instrumented contract including the test helpers and mocks, so it reports a number several
points below the source tree's own. Both figures are true and only one of them answers the brief.

So this script answers the brief instead:

  1. Every `src/libraries/*.sol` must be 100% on lines, statements, branches and functions.
     All four, not just branches: the brief names branches, but a library at 100% branches and 80%
     lines has branches nobody reached.
  2. The source tree as a whole -- `src/**`, and nothing else -- must be at least 95% lines.

Exit status is non-zero if either fails, so `make check` fails with it.

Usage:
    tools/check_coverage.py            # runs `forge coverage` itself
    tools/check_coverage.py --from FILE  # parses a saved report instead
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = REPO_ROOT / "contracts"

#: The bar the brief sets for `contracts/src/libraries/`.
LIBRARY_REQUIRED_PERCENT = 100.0
#: The bar the brief sets overall, applied to `src/**` rather than to `forge`'s Total row.
SOURCE_REQUIRED_PERCENT = 95.0

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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--from",
        dest="source",
        type=Path,
        default=None,
        help="parse a saved coverage report instead of running forge",
    )
    arguments = parser.parse_args()

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

    failures: list[str] = []
    check_libraries(files, failures)
    source_percent = check_source_total(files, failures)

    library_count = sum(1 for f in files if f.path.startswith("src/libraries/"))
    if failures:
        print(f"check_coverage: {len(failures)} violation(s)", file=sys.stderr)
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    print(
        f"check_coverage: all checks passed "
        f"({library_count} libraries at 100% on all four metrics, "
        f"src/** at {source_percent:.2f}% lines)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
