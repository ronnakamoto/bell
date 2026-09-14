"""Test configuration.

Puts `calibrator/src` on the path so the suite runs from a fresh clone without an editable install,
and exposes the repository root so the contract tests can read the shared fixtures.
"""

from __future__ import annotations

import sys
from pathlib import Path

CALIBRATOR_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = CALIBRATOR_ROOT.parent
SRC = CALIBRATOR_ROOT / "src"

if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
