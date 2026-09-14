"""BELL settlement reference service.

Evaluates the settlement routes and adjudicates challenges to a committed parameter set.
Depends on `bell_calibrator.domain` for the shared domain core -- the moment primitives and
the commitment digest -- and the dependency runs one way only: the calibrator must never
import from this package.
"""

__all__: list[str] = []
