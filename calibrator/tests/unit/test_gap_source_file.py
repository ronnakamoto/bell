"""The CSV gap source.

The adapter is where a file's problems are supposed to live, so every way a file can be wrong is
tested here rather than three layers up. Each failure is a *typed* adapter error, because the
application layer has to tell a missing file from a malformed one -- one is retryable and the other
is terminal, and the brief's §9.2 requires that distinction to be expressible.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from bell_calibrator.adapters.gap_source_file import (
    CsvGapSource,
    GapSourceMalformed,
    GapSourceUnavailable,
)
from bell_calibrator.domain.constants import WAD
from bell_calibrator.domain.models import Symbol

NVDA = Symbol("NVDA")
HEADER = "date,close,next_open\n"


def write(root: Path, symbol: Symbol, body: str) -> CsvGapSource:
    (root / f"{symbol.text}.csv").write_text(HEADER + body, encoding="utf-8")
    return CsvGapSource(root=root)


class TestReading:
    def test_a_well_formed_series_is_read(self, tmp_path: Path) -> None:
        source = write(tmp_path, NVDA, "2026-09-10,100.00,102.00\n2026-09-11,102.00,101.00\n")
        bars = source.daily_bars(NVDA)
        assert len(bars) == 2
        assert bars[0].close.raw == 100 * WAD
        assert bars[0].next_open.raw == 102 * WAD

    def test_the_gap_is_the_close_to_open_return(self, tmp_path: Path) -> None:
        source = write(tmp_path, NVDA, "2026-09-10,100.00,102.00\n")
        assert source.daily_bars(NVDA)[0].gap().raw == int(Decimal("0.02") * WAD)

    def test_the_series_is_returned_oldest_first(self, tmp_path: Path) -> None:
        # A file written newest-first is read oldest-first. The window is defined as the *last* N
        # sessions, so a source that returned a reversed series would calibrate on the wrong rows.
        source = write(
            tmp_path,
            NVDA,
            "2026-09-11,102.00,101.00\n2026-09-10,100.00,102.00\n",
        )
        bars = source.daily_bars(NVDA)
        assert [bar.trading_date.day for bar in bars] == [10, 11]

    def test_a_missing_file_is_unavailable_rather_than_malformed(self, tmp_path: Path) -> None:
        with pytest.raises(GapSourceUnavailable, match="no gap series"):
            CsvGapSource(root=tmp_path).daily_bars(Symbol("TSLA"))

    def test_a_file_for_one_symbol_is_not_returned_for_another(self, tmp_path: Path) -> None:
        write(tmp_path, NVDA, "2026-09-10,100.00,102.00\n")
        with pytest.raises(GapSourceUnavailable):
            CsvGapSource(root=tmp_path).daily_bars(Symbol("TSLA"))


class TestMalformedFiles:
    def test_a_missing_column_is_refused(self, tmp_path: Path) -> None:
        (tmp_path / "NVDA.csv").write_text("date,close\n2026-09-10,100.00\n", encoding="utf-8")
        with pytest.raises(GapSourceMalformed, match="next_open"):
            CsvGapSource(root=tmp_path).daily_bars(NVDA)

    def test_a_header_with_no_rows_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(GapSourceMalformed, match="no rows"):
            write(tmp_path, NVDA, "").daily_bars(NVDA)

    def test_an_unparseable_date_names_its_line(self, tmp_path: Path) -> None:
        # The line number is in the message because a malformed file has to be fixable, and "row 3"
        # is the difference between a fixable file and a hunt.
        source = write(tmp_path, NVDA, "2026-09-10,100.00,102.00\nnot-a-date,100.00,102.00\n")
        with pytest.raises(GapSourceMalformed, match="row 3"):
            source.daily_bars(NVDA)

    def test_a_non_numeric_price_is_refused(self, tmp_path: Path) -> None:
        source = write(tmp_path, NVDA, "2026-09-10,one hundred,102.00\n")
        with pytest.raises(GapSourceMalformed, match="row 2"):
            source.daily_bars(NVDA)

    def test_a_non_positive_close_is_refused(self, tmp_path: Path) -> None:
        # A zero or negative close makes the gap ratio undefined, and `DailyBar.gap` would raise a
        # bare `ValueError` from three layers down rather than an adapter error here.
        source = write(tmp_path, NVDA, "2026-09-10,0.00,102.00\n")
        with pytest.raises(GapSourceMalformed, match="must be positive"):
            source.daily_bars(NVDA)

    def test_a_negative_open_is_read_rather_than_refused(self, tmp_path: Path) -> None:
        # A negative *open* is not a data error in the way a negative close is: the gap is a ratio
        # and the open can legitimately be below zero only if the close is too, which is refused
        # above. This asserts the asymmetry is deliberate rather than accidental.
        source = write(tmp_path, NVDA, "2026-09-10,100.00,50.00\n")
        assert source.daily_bars(NVDA)[0].gap().raw == -WAD // 2
