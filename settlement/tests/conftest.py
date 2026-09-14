"""Put both workspaces on the import path.

The settlement service depends on the calibrator's domain core, and the two are path dependencies
within one repository rather than published packages. Adding both `src` directories here is what
`make build` would otherwise do with two editable installs; doing it in one place means the tests
run
from a fresh clone with no install step, which is the brief's §13.4 requirement.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

for workspace in ("calibrator", "settlement"):
    source_root = REPO_ROOT / workspace / "src"
    if source_root.is_dir() and str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))
