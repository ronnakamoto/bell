"""A gap source backed by a CSV file.

The adapter the domain's `GapSource` port exists for. Everything that can go wrong with a file goes
wrong here and nowhere else: the format, the encoding, the date parsing, the unit conversion and the
row-level validation. `domain/` receives `DailyBar` value objects and never learns that a file was
involved, which is what lets the domain be tested with literals.

Every failure is a typed adapter error rather than a `ValueError`, so the application layer can tell
a missing file from a malformed one -- one is retryable and the other is terminal, and the brief's
§9.2 requires that distinction to be expressible.
"""

from __future__ import annotations

import csv
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import DecimalException
from pathlib import Path

from bell_calibrator.domain.models import DailyBar, Symbol, Wad

#: The columns a source file must carry. Named rather than positional so that a file with an extra
#: column is accepted and one with the columns reordered is not silently misread.
DATE_COLUMN = "date"
CLOSE_COLUMN = "close"
NEXT_OPEN_COLUMN = "next_open"

_REQUIRED_COLUMNS = (DATE_COLUMN, CLOSE_COLUMN, NEXT_OPEN_COLUMN)


class GapSourceUnavailable(Exception):
    """The file could not be read at all. Retryable, in the sense that the file may appear."""


class GapSourceMalformed(Exception):
    """The file was read but its contents are not a gap series. Terminal."""


@dataclass(frozen=True, slots=True)
class CsvGapSource:
    """Reads one CSV per symbol from a directory.

    The directory rather than the file is the configuration, so the symbol selects the file and the
    adapter holds no per-symbol state. A symbol with no file is `GapSourceUnavailable`, which is the
    same outcome as a symbol whose file has not been written yet -- and the caller cannot tell the
    difference, which is correct because it has the same remedy.
    """

    root: Path

    def daily_bars(self, symbol: Symbol) -> Sequence[DailyBar]:
        """Every daily bar for `symbol`, oldest first."""
        path = self.root / f"{symbol.text}.csv"
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError as missing:
            raise GapSourceUnavailable(f"no gap series at {path}") from missing
        except OSError as unreadable:
            raise GapSourceUnavailable(f"could not read {path}: {unreadable}") from unreadable

        rows = list(csv.DictReader(text.splitlines()))
        if not rows:
            raise GapSourceMalformed(f"{path} has a header but no rows")

        missing_columns = [column for column in _REQUIRED_COLUMNS if column not in rows[0]]
        if missing_columns:
            raise GapSourceMalformed(
                f"{path} is missing {', '.join(missing_columns)}; expected "
                f"{', '.join(_REQUIRED_COLUMNS)}"
            )

        bars = tuple(_parse_row(path, index, row) for index, row in enumerate(rows))
        return tuple(sorted(bars, key=lambda bar: bar.trading_date))


def _parse_row(path: Path, index: int, row: dict[str, str]) -> DailyBar:
    """One row, with every failure named by its line so a malformed file is fixable."""
    try:
        trading_date = date.fromisoformat(row[DATE_COLUMN].strip())
        close = Wad.from_str(row[CLOSE_COLUMN].strip())
        next_open = Wad.from_str(row[NEXT_OPEN_COLUMN].strip())
    except (KeyError, ValueError, DecimalException) as malformed:
        # `DecimalException` is caught as well as `ValueError`, and the distinction is not cosmetic:
        # `Decimal("one hundred")` raises `InvalidOperation`, which derives from `ArithmeticError`
        # rather than from `ValueError`. An `except ValueError` alone would let a malformed price
        # escape the adapter as a decimal exception, which is exactly the leak this layer exists to
        # prevent -- the caller would see an arithmetic failure from three layers down instead of a
        # named adapter error about a file.
        raise GapSourceMalformed(f"{path} row {index + 2}: {malformed}") from malformed
    if close.raw <= 0:
        raise GapSourceMalformed(f"{path} row {index + 2}: a close must be positive")
    return DailyBar(trading_date=trading_date, close=close, next_open=next_open)
