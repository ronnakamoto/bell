"""Adapters. Implement the ports declared in `bell_calibrator.domain.ports`.

The layer exists now, empty, so that the `import-linter` contracts in `pyproject.toml` are enforced
from the first commit rather than bolted on once there is code to violate them.

What will live here, per build brief §6:

  gap_source_http.py   the Nasdaq daily-OHLC client
  gap_source_file.py   the cached-sample reader
  calendar_csv.py      the announcement calendar
  registry_client.py   the keccak primitive and the RPC client for the premium registry

This is the only layer that may touch the network, the filesystem, a clock, or a third-party
package. `bell_calibrator.domain` is checked against that rule by `tools/check_layout.py` and by the
`import-linter` contract, not by convention.
"""

__all__: list[str] = []
