"""Reference prints, and the deterministic selection over them.

This module mirrors `contracts/src/core/ReferencePrintBook.sol` deliberately and in detail: the same
qualification rule, the same ordering, the same refusal. The two have to agree. A settlement
evaluated here and a settlement evaluated on chain must reach the same branch from the same prints,
because a difference in tie-breaking would produce a *different payoff* from identical inputs --
which is the one failure a settlement reference service cannot have, since the whole point of the
reference is to be checkable against the contract.

The ordering is `(priority ascending, timestamp descending, insertion index ascending)`, and it is
total: no two prints compare equal, because the insertion index is unique.

Result types rather than exceptions for the absent case, because "no print qualifies" is a domain
outcome rather than a failure. The contract reverts, because a contract has no other way to say it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta

# ---------------------------------------------------------------- the print


@dataclass(frozen=True, slots=True)
class ReferencePrint:
    """One reported observation of a session's gap.

    `gap_wad` is signed and at WAD scale. The payoff is an even function of it, so a negative gap
    settles exactly as its magnitude does, but the sign is carried because a settlement record that
    discarded it could not be audited against the print it came from.
    """

    source: str
    priority: int
    timestamp: datetime
    gap_wad: int
    insertion_index: int

    def __post_init__(self) -> None:
        if self.priority < 0:
            raise ValueError("a print priority cannot be negative")
        if self.insertion_index < 0:
            raise ValueError("an insertion index cannot be negative")

    @property
    def magnitude_wad(self) -> int:
        """`|gap|`, which is what every magnitude guard compares against."""
        return abs(self.gap_wad)


# ---------------------------------------------------------------- the result type


@dataclass(frozen=True, slots=True)
class PrintSelected:
    """A print qualified, and this is the one."""

    print: ReferencePrint
    is_stale: bool


@dataclass(frozen=True, slots=True)
class NoPrintQualifies:
    """Nothing qualified. A designed outcome, not a failure."""

    considered: int
    reason: str


SelectionResult = PrintSelected | NoPrintQualifies


# ---------------------------------------------------------------- selection


def select_print(
    prints: tuple[ReferencePrint, ...],
    *,
    not_before: datetime,
    now: datetime,
    freshness_bound: timedelta,
    stale_bound: timedelta,
) -> SelectionResult:
    """The settlement print, or a report that none qualifies.

    A print qualifies when it was observed at or after `not_before` -- the session's expiry itself
    --
    so a print from before the open cannot settle it -- and when it is no older than `stale_bound`.
    Within the freshness bound it is live; between the two it is stale, and the caller is told
    which rather than having to infer it.
    """
    if stale_bound < freshness_bound:
        raise ValueError("the stale bound cannot be shorter than the freshness bound")

    candidates = tuple(
        candidate
        for candidate in prints
        if _qualifies(candidate, not_before=not_before, now=now, stale_bound=stale_bound)
    )
    if not candidates:
        return NoPrintQualifies(
            considered=len(prints),
            reason="no print was observed after the expiry and inside the staleness bound",
        )

    chosen = best_print(candidates)
    return PrintSelected(print=chosen, is_stale=_age(chosen.timestamp, now) > freshness_bound)


def best_print(candidates: tuple[ReferencePrint, ...]) -> ReferencePrint:
    """The winning print under the total ordering.

    Written as three explicit passes rather than a single sort key. A sort key would need the
    timestamp reversed, and the two ways to reverse a `datetime` in a key are to negate the
    timestamp
    -- which is a `float` in domain code -- or to sort twice. Three passes say what the ordering is
    and cannot be got subtly wrong.
    """
    if not candidates:
        raise ValueError("best_print needs at least one candidate")

    lowest_priority = min(candidate.priority for candidate in candidates)
    by_priority = tuple(c for c in candidates if c.priority == lowest_priority)

    latest = max(candidate.timestamp for candidate in by_priority)
    by_timestamp = tuple(c for c in by_priority if c.timestamp == latest)

    return min(by_timestamp, key=lambda candidate: candidate.insertion_index)


def _qualifies(
    candidate: ReferencePrint, *, not_before: datetime, now: datetime, stale_bound: timedelta
) -> bool:
    if candidate.timestamp < not_before:
        return False
    return _age(candidate.timestamp, now) <= stale_bound


def _age(timestamp: datetime, now: datetime) -> timedelta:
    """The print's age, floored at zero.

    Floored rather than signed because a print dated in the future is a feed fault, not a negative
    age, and a negative age would pass every freshness test. The contract does the same, for the
    same reason.
    """
    return now - timestamp if now >= timestamp else timedelta(0)
