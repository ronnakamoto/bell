"""Test package marker.

Present so mypy resolves the suites as `tests.unit.*` and `tests.contract.*` rather than as
top-level modules, which is what the per-module override in pyproject.toml keys on.
"""
