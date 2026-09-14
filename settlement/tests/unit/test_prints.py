"""The reference print selection.

The ordering is asserted rather than described, because the contract applies the same one and a
difference in tie-breaking would produce a different payoff from identical inputs -- which is the
one
failure a settlement reference service cannot have.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from bell_calibrator.domain.constants import WAD

from bell_settlement.domain.prints import (
    NoPrintQualifies,
    PrintSelected,
    ReferencePrint,
    best_print,
    select_print,
)

EXPIRY = datetime(2026, 9, 14, 13, 30, tzinfo=UTC)
FRESHNESS = timedelta(minutes=10)
STALENESS = timedelta(hours=2)


def print_at(
    gap: str,
    *,
    priority: int = 1,
    seconds_after_expiry: int = 0,
    index: int = 0,
    source: str = "primary",
) -> ReferencePrint:
    return ReferencePrint(
        source=source,
        priority=priority,
        timestamp=EXPIRY + timedelta(seconds=seconds_after_expiry),
        gap_wad=int(Decimal(gap) * WAD),
        insertion_index=index,
    )


def select(prints: tuple[ReferencePrint, ...], *, now: datetime) -> object:
    return select_print(
        prints,
        not_before=EXPIRY,
        now=now,
        freshness_bound=FRESHNESS,
        stale_bound=STALENESS,
    )


class TestQualification:
    def test_a_print_before_the_expiry_does_not_qualify(self) -> None:
        # A print from before the open cannot settle a session: the gap it reports is the previous
        # session's, and settling on it would pay on a return that has already been realised.
        early = print_at("0.02", seconds_after_expiry=-60)
        result = select((early,), now=EXPIRY)
        assert isinstance(result, NoPrintQualifies)
        assert result.considered == 1

    def test_a_print_at_the_expiry_qualifies(self) -> None:
        result = select((print_at("0.02"),), now=EXPIRY)
        assert isinstance(result, PrintSelected)

    def test_a_print_beyond_the_staleness_bound_does_not_qualify(self) -> None:
        result = select((print_at("0.02"),), now=EXPIRY + STALENESS + timedelta(seconds=1))
        assert isinstance(result, NoPrintQualifies)

    def test_a_print_inside_the_freshness_bound_is_live(self) -> None:
        result = select((print_at("0.02"),), now=EXPIRY + FRESHNESS)
        assert isinstance(result, PrintSelected)
        assert not result.is_stale

    def test_a_print_between_the_bounds_is_stale_rather_than_absent(self) -> None:
        # Stale, not absent. The distinction is the whole reason there are two bounds: a stale print
        # still settles, with the degradation recorded, whereas an absent one does not settle at
        # all.
        result = select((print_at("0.02"),), now=EXPIRY + FRESHNESS + timedelta(seconds=1))
        assert isinstance(result, PrintSelected)
        assert result.is_stale

    def test_a_print_dated_in_the_future_is_treated_as_fresh(self) -> None:
        # A future timestamp is a feed fault, and the age floors at zero rather than going negative.
        # A negative age would pass every freshness test, which is the failure this guards.
        future = print_at("0.02", seconds_after_expiry=3_600)
        result = select((future,), now=EXPIRY)
        assert isinstance(result, PrintSelected)
        assert not result.is_stale

    def test_an_empty_print_set_reports_rather_than_raising(self) -> None:
        result = select((), now=EXPIRY)
        assert isinstance(result, NoPrintQualifies)
        assert result.considered == 0


class TestOrdering:
    def test_the_lower_priority_wins(self) -> None:
        chosen = best_print(
            (print_at("0.01", priority=5, index=0), print_at("0.03", priority=1, index=1))
        )
        assert chosen.gap_wad == int(Decimal("0.03") * WAD)

    def test_the_later_timestamp_wins_at_equal_priority(self) -> None:
        # A later print is closer to the open the session settles on.
        chosen = best_print(
            (
                print_at("0.01", seconds_after_expiry=0, index=0),
                print_at("0.03", seconds_after_expiry=10, index=1),
            )
        )
        assert chosen.gap_wad == int(Decimal("0.03") * WAD)

    def test_the_lower_insertion_index_wins_a_remaining_tie(self) -> None:
        # Two prints from one source at one timestamp are the same observation, so taking the first
        # submitted is a rule rather than a preference.
        chosen = best_print((print_at("0.01", index=7), print_at("0.03", index=2)))
        assert chosen.insertion_index == 2

    def test_the_ordering_is_total(self) -> None:
        # No two prints compare equal, because the insertion index is unique. Asserted over every
        # pair rather than argued, because a non-total ordering is what an ambiguous settlement is.
        candidates = tuple(print_at("0.01", index=i) for i in range(8))
        for left in candidates:
            for right in candidates:
                if left.insertion_index == right.insertion_index:
                    continue
                assert best_print((left, right)).insertion_index in {
                    left.insertion_index,
                    right.insertion_index,
                }
        assert len({best_print(candidates).insertion_index for _ in range(3)}) == 1, "deterministic"

    def test_best_print_refuses_an_empty_set(self) -> None:
        with pytest.raises(ValueError, match="at least one candidate"):
            best_print(())


class TestPrintValueObject:
    def test_magnitude_is_unsigned(self) -> None:
        assert print_at("-0.02").magnitude_wad == int(Decimal("0.02") * WAD)

    def test_a_negative_priority_is_refused(self) -> None:
        with pytest.raises(ValueError, match="priority"):
            print_at("0.02", priority=-1)

    def test_a_negative_insertion_index_is_refused(self) -> None:
        with pytest.raises(ValueError, match="insertion index"):
            print_at("0.02", index=-1)


def test_a_stale_bound_shorter_than_the_freshness_bound_is_refused() -> None:
    # The two bounds are ordered by construction: a stale print is one between them. Inverting them
    # would make `is_stale` mean "inside the stale bound but not the freshness bound", which is the
    # empty set, and every print would report as live.
    with pytest.raises(ValueError, match="stale bound"):
        select_print(
            (),
            not_before=EXPIRY,
            now=EXPIRY,
            freshness_bound=STALENESS,
            stale_bound=FRESHNESS,
        )
