#!/usr/bin/env python3
"""Assert the structural rules of the build brief mechanically.

The brief's §5.3 says it plainly: *"A stated rule that is not checked is a preference, not an
architecture."* Everything below is a rule the brief states and that a reader could otherwise only
verify by reading the whole repository.

Checks:

  1. §5.1 / §5.3  `domain/` imports nothing but the standard library and itself.
  2. §6          No `utils.py`, `helpers.py`, `common.py`. These are where unrelated code hides.
  3. §8.1        No source file exceeds 400 lines.
  4. §6          Tests mirror source: every `src/libraries/X.sol` has `test/unit/X.t.sol`.
  5. §7.2        No `require` with a string in Solidity. Custom errors only.
  6. §8.4        No `TODO` without an issue reference.

Exit status is non-zero if any check fails, so `make check` fails with it.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = REPO_ROOT / "contracts"

#: Each Python workspace, with the package it holds and the import prefixes its `domain/` may use.
#: The settlement service may import the calibrator's domain -- the two share a domain core -- but
#: not the other way round, which the settlement workspace's import-linter contract asserts.
WORKSPACES: tuple[tuple[Path, str, tuple[str, ...]], ...] = (
    (REPO_ROOT / "calibrator" / "src", "bell_calibrator", ("bell_calibrator.domain",)),
    (
        REPO_ROOT / "settlement" / "src",
        "bell_settlement",
        ("bell_settlement.domain", "bell_calibrator.domain"),
    ),
)

MAX_SOURCE_LINES = 400
BANNED_MODULE_NAMES = frozenset({"utils.py", "helpers.py", "common.py"})
REQUIRE_WITH_STRING = re.compile(r"\brequire\s*\(\s*[^,)]*,\s*[\"']")
TODO_PATTERN = re.compile(r"\bTODO\b(?!\(#\d+\))(?!\s*:?\s*#\d+)")


class Report:
    """Collects failures so one run reports every violation rather than the first."""

    def __init__(self) -> None:
        self.failures: list[str] = []

    def fail(self, message: str) -> None:
        self.failures.append(message)

    def summarise(self) -> int:
        if not self.failures:
            print(f"check_layout: all checks passed")
            return 0
        print(f"check_layout: {len(self.failures)} violation(s)", file=sys.stderr)
        for failure in self.failures:
            print(f"  {failure}", file=sys.stderr)
        return 1


def python_sources() -> list[Path]:
    """Every Python source in every workspace."""
    found: list[Path] = []
    for source_root, _package, _allowed in WORKSPACES:
        if source_root.exists():
            found.extend(sorted(source_root.rglob("*.py")))
    return found


def solidity_sources() -> list[Path]:
    return sorted((CONTRACTS / "src").rglob("*.sol"))


def check_domain_purity(report: Report) -> None:
    """`domain/` may import only the standard library and the prefixes its workspace allows."""
    for source_root, package, allowed_prefixes in WORKSPACES:
        domain = source_root / package / "domain"
        if not domain.exists():
            continue
        for path in sorted(domain.rglob("*.py")):
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                else:
                    continue
                for name in names:
                    root = name.split(".")[0]
                    if root in sys.stdlib_module_names:
                        continue
                    if any(name.startswith(prefix) for prefix in allowed_prefixes):
                        continue
                    report.fail(
                        f"{path.relative_to(REPO_ROOT)} imports {name!r}; "
                        f"domain/ may import only the standard library and "
                        f"{', '.join(allowed_prefixes)}"
                    )


def check_banned_module_names(report: Report) -> None:
    for path in python_sources():
        if path.name in BANNED_MODULE_NAMES:
            report.fail(f"{path.relative_to(REPO_ROOT)}: name the module for what it does")


def check_file_lengths(report: Report) -> None:
    candidates = python_sources() + solidity_sources()
    for path in candidates:
        lines = len(path.read_text().splitlines())
        if lines > MAX_SOURCE_LINES:
            report.fail(
                f"{path.relative_to(REPO_ROOT)}: {lines} lines exceeds the {MAX_SOURCE_LINES} limit"
            )


def check_tests_mirror_source(report: Report) -> None:
    """Every library under `src/libraries/` must have a unit test of the same name."""
    libraries = CONTRACTS / "src" / "libraries"
    if not libraries.exists():
        return
    for library in sorted(libraries.glob("*.sol")):
        expected = CONTRACTS / "test" / "unit" / f"{library.stem}.t.sol"
        if not expected.exists():
            report.fail(
                f"{library.relative_to(REPO_ROOT)} has no test at "
                f"{expected.relative_to(REPO_ROOT)}; a reader must be able to find a test "
                f"from a filename"
            )


def check_no_require_strings(report: Report) -> None:
    for path in solidity_sources():
        for number, line in enumerate(path.read_text().splitlines(), start=1):
            if REQUIRE_WITH_STRING.search(line):
                report.fail(
                    f"{path.relative_to(REPO_ROOT)}:{number}: require with a string; "
                    f"custom errors only"
                )


def check_todos_are_tracked(report: Report) -> None:
    for path in python_sources() + solidity_sources():
        for number, line in enumerate(path.read_text().splitlines(), start=1):
            if TODO_PATTERN.search(line):
                report.fail(
                    f"{path.relative_to(REPO_ROOT)}:{number}: TODO without an issue reference"
                )


def main() -> int:
    report = Report()
    check_domain_purity(report)
    check_banned_module_names(report)
    check_file_lengths(report)
    check_tests_mirror_source(report)
    check_no_require_strings(report)
    check_todos_are_tracked(report)
    return report.summarise()


if __name__ == "__main__":
    raise SystemExit(main())
