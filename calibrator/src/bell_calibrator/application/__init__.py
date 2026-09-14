"""Use cases. Orchestrates `domain`; imports nothing from `adapters`.

The layer exists now, empty, so that the `import-linter` contracts in `pyproject.toml` are enforced
from the first commit rather than bolted on once there is code to violate them. A stated rule that
is not checked is a preference, not an architecture.

What will live here, per build brief §6:

  calibrate.py   the use case: ingest -> classify -> estimate leverage -> fit the premium -> publish
  publish.py     commit the parameter set to the registry before the session opens

Both depend on the ports in `bell_calibrator.domain.ports` and on nothing else.
"""

__all__: list[str] = []
