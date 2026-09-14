"""BELL off-chain calibration and publishing service.

Layered per build brief §5.3: `domain` is pure and imports nothing outside the standard library,
`application` imports `domain`, `adapters` import both. Enforced by `import-linter` in
`pyproject.toml` and run by `make check`.
"""

__all__ = ["domain"]
