"""Unit tests for session classification and the estimability screen."""

from __future__ import annotations

from datetime import date

import pytest

from bell_calibrator.domain import sessions
from bell_calibrator.domain.models import DailyBar, SessionKind, Symbol, Wad

WAD = 10**18


class TestClassification:
    def test_spans_map_to_the_taxonomy(self) -> None:
        assert sessions.classify(sessions.SessionSpan(1)) is SessionKind.OVERNIGHT
        assert sessions.classify(sessions.SessionSpan(3)) is SessionKind.WEEKEND
        assert sessions.classify(sessions.SessionSpan(2)) is SessionKind.HOLIDAY
        assert sessions.classify(sessions.SessionSpan(4)) is SessionKind.HOLIDAY
        assert sessions.classify(sessions.SessionSpan(5)) is SessionKind.HOLIDAY

    def test_an_announcement_short_circuits_the_span(self) -> None:
        # The ordering is the whole point: an announcement gap is Overnight by duration and a
        # different object by distribution, so a rule that tested the span first would pool it with
        # the overnight sample and understate the premium by 4.0 to 16.5% (paper §7.10).
        span = sessions.SessionSpan(1, contains_scheduled_announcement=True)
        assert sessions.classify(span) is SessionKind.EVENT

    def test_an_announcement_on_a_weekend_span_is_still_an_event(self) -> None:
        span = sessions.SessionSpan(3, contains_scheduled_announcement=True)
        assert sessions.classify(span) is SessionKind.EVENT

    def test_rejects_a_sub_day_span(self) -> None:
        with pytest.raises(ValueError, match="at least one calendar day"):
            sessions.SessionSpan(0)


class TestPooling:
    def test_only_overnight_is_per_name(self) -> None:
        assert not sessions.is_pooled_with_weekend(SessionKind.OVERNIGHT)
        assert sessions.is_pooled_with_weekend(SessionKind.WEEKEND)
        assert sessions.is_pooled_with_weekend(SessionKind.HOLIDAY)
        assert sessions.is_pooled_with_weekend(SessionKind.EVENT)


class TestTailObservationScreen:
    def test_reproduces_the_papers_table_fourteen(self) -> None:
        # The governing quantity is the expected count at or beyond the 99th percentile, not the
        # sample size: 19.65 overnight, 4.52 on a weekend, 0.96 on a holiday, 0.34 in an event
        # session. Everything else in the paper's Table 14 follows from this column.
        expected = {
            1965: 19.65,
            452: 4.52,
            96: 0.96,
            34: 0.34,
        }
        for observations, tail in expected.items():
            assert sessions.expected_tail_observations(observations, 0.01) == pytest.approx(
                tail, abs=0.01
            )


class TestDailyBar:
    def test_gap_is_the_close_to_open_return(self) -> None:
        bar = DailyBar(
            trading_date=date(2026, 9, 10),
            close=Wad(100 * WAD),
            next_open=Wad(102 * WAD),
        )
        assert bar.gap() == Wad(2 * WAD // 100)

    def test_gap_is_signed(self) -> None:
        bar = DailyBar(
            trading_date=date(2026, 9, 10),
            close=Wad(100 * WAD),
            next_open=Wad(98 * WAD),
        )
        assert bar.gap() == Wad(-2 * WAD // 100)

    def test_rejects_a_non_positive_close(self) -> None:
        bar = DailyBar(trading_date=date(2026, 9, 10), close=Wad(0), next_open=Wad(WAD))
        with pytest.raises(ValueError, match="positive"):
            bar.gap()


class TestSymbol:
    def test_accepts_canonical_tickers(self) -> None:
        for text in ("NVDA", "TSLA", "AAPL", "BRK.B"):
            assert Symbol(text).text == text

    def test_rejects_non_canonical_tickers(self) -> None:
        for text in ("nvda", "1NVDA", "", "TOOLONGSYMBOL", "NV DA"):
            with pytest.raises(ValueError, match="canonical ticker"):
                Symbol(text)
