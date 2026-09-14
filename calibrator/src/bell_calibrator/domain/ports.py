"""Ports. Protocols only -- no implementations, no imports beyond the standard library.

Ports are declared in the domain and implemented by adapters, so the dependency arrow points inward
(build brief §5.3). The reason the gap source is a port rather than an HTTP client is stated in the
brief and is worth repeating: the gap-data source will change, and the domain must not.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Protocol, runtime_checkable

from bell_calibrator.domain.models import DailyBar, ParameterSet, Symbol


@runtime_checkable
class Keccak(Protocol):
    """A keccak-256 hash.

    A callable rather than a named method, because that is the shape the primitive actually has and
    because it makes the test double a one-line lambda rather than a class.
    """

    def __call__(self, data: bytes) -> bytes:
        """Return the 32-byte keccak-256 digest of `data`."""
        ...


@runtime_checkable
class GapSource(Protocol):
    """A source of daily bars for a reference equity.

    Implemented by an HTTP adapter, a file adapter, and -- for the tests and for the synthetic
    development path -- a generator. The domain never learns which.
    """

    def daily_bars(self, symbol: Symbol) -> Sequence[DailyBar]:
        """All available daily bars for `symbol`, oldest first."""
        ...


@runtime_checkable
class AnnouncementCalendar(Protocol):
    """A source of scheduled announcement dates.

    Scheduled, not reported. The distinction is the whole basis of the event-session calibration:
    conditioning on a *scheduled* release removes the surprise, which is why the event session is
    high-variance but not fat-tailed and why the fat-tail machinery is required for the non-event
    pool and not for this one (paper §7.10).
    """

    def announcement_dates(self, symbol: Symbol) -> Sequence[date]:
        """Scheduled announcement dates for `symbol`, ascending."""
        ...


@runtime_checkable
class ParameterPublisher(Protocol):
    """The off-chain side of the premium commitment.

    The trust shift this port creates is deliberate and is policed rather than assumed: the
    publisher commits a parameter set and the inputs it consumed *before* the session opens, so it
    cannot fit after seeing the outcome, and the committed inputs make a challenge a re-run rather
    than a matter of testimony (paper §7.11).
    """

    def publish(self, parameters: ParameterSet, for_session: int) -> str:
        """Commit `parameters` for `for_session`; return the commitment digest as hex."""
        ...
