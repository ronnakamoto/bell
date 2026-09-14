"""The calibration use case.

The use case is tested against literal bars rather than a fixture, because that is the test the
brief
applies for whether something belongs in the application layer: it sequences the domain's pieces and
touches nothing, so it is callable with arguments.
"""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from Crypto.Hash import keccak

from bell_calibrator.application.calibrate import (
    CalibrationRequest,
    calibrate,
    rows_digest,
    window_for,
)
from bell_calibrator.domain import constants
from bell_calibrator.domain.families import FAMILIES
from bell_calibrator.domain.leverage import is_on_harmonic_ladder
from bell_calibrator.domain.models import (
    Calibrated,
    DailyBar,
    InsufficientSample,
    SessionKind,
    Symbol,
    Wad,
)

WAD = constants.WAD
NVDA = Symbol("NVDA")
SOURCE_IDS = ("test-fixture",)


def reference_keccak(data: bytes) -> bytes:
    hasher = keccak.new(digest_bits=256)
    hasher.update(data)
    return bytes(hasher.digest())


def bars_from_gaps(gaps: tuple[str, ...], *, start: date = date(2020, 1, 6)) -> tuple[DailyBar,
...]:
    """A bar series whose gaps are exactly the ones given.

    The close is held at 100 and the next open is set from the gap, so a gap of `0.02` is a bar with
    `next_open = 102`. Holding the close constant keeps the series easy to reason about and makes
    the
    gap the only thing a test has to state.
    """
    built: list[DailyBar] = []
    for index, gap in enumerate(gaps):
        close = Wad(100 * WAD)
        next_open = Wad(100 * WAD + int(Decimal(gap) * WAD) * 100)
        built.append(
            DailyBar(
                trading_date=start + timedelta(days=index),
                close=close,
                next_open=next_open,
            )
        )
    return tuple(built)


class TestTheWindow:
    def test_the_overnight_window_is_the_published_one(self) -> None:
        assert window_for(SessionKind.OVERNIGHT, NVDA) == 504

    def test_aaple_is_the_one_per_name_exception(self) -> None:
        # The paper records a 378-session overnight window for AAPL against 504 for the others.
        assert window_for(SessionKind.OVERNIGHT, Symbol("AAPL")) == 378

    def test_the_weekend_and_holiday_share_a_window(self) -> None:
        assert window_for(SessionKind.WEEKEND, NVDA) == window_for(SessionKind.HOLIDAY, NVDA)
        assert window_for(SessionKind.WEEKEND, NVDA) == 126

    def test_an_event_session_has_no_pooled_window(self) -> None:
        # The event session is calibrated per name with a pooled shape and a shrunk scale, which is
        # not a window and must not be answered with one.
        import pytest

        with pytest.raises(ValueError, match="per name"):
            window_for(SessionKind.EVENT, NVDA)


class TestCalibration:
    def test_a_sufficient_sample_produces_a_parameter_set(self) -> None:
        bars = bars_from_gaps(tuple("0.01" for _ in range(600)))
        result = calibrate(_request(600), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(result, Calibrated)
        assert result.parameters.symbol == NVDA
        assert result.parameters.session is SessionKind.OVERNIGHT
        assert result.parameters.model == "empirical"

    def test_the_leverage_is_a_whole_number(self) -> None:
        # The lattice gate refuses an off-lattice leverage, so a calibrator that produced one would
        # publish a parameter set the factory could not list.
        bars = bars_from_gaps(tuple("0.01" for _ in range(600)))
        result = calibrate(_request(600), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(result, Calibrated)
        assert is_on_harmonic_ladder(result.parameters.lam)

    def test_a_constant_series_gives_a_leverage_above_one(self) -> None:
        # Every gap is 1%, so the 99th percentile is 1% and the leverage is about 100.
        bars = bars_from_gaps(tuple("0.01" for _ in range(600)))
        result = calibrate(_request(600), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(result, Calibrated)
        assert result.parameters.lam.raw // WAD >= 2

    def test_a_short_series_is_an_insufficient_sample(self) -> None:
        bars = bars_from_gaps(tuple("0.01" for _ in range(10)))
        result = calibrate(_request(504), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(result, InsufficientSample)
        assert result.observations == 10
        assert result.required_tail_observations == 504

    def test_the_tail_screen_fires_below_one_tail_observation(self) -> None:
        # The screen is on the *tail count*, not the sample size, and this is what makes holidays
        # pooled: a 96-observation holiday window holds 0.96 tail observations at alpha = 1%, which
        # is not enough to place a quantile. The window is supplied, so the screen is the only thing
        # standing between a 96-session window and a published leverage.
        bars = bars_from_gaps(tuple("0.01" for _ in range(96)))
        result = calibrate(_request(96), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(result, InsufficientSample)

    def test_a_hundred_observations_clears_the_screen(self) -> None:
        # Exactly one tail observation, which is the boundary and is admitted.
        bars = bars_from_gaps(tuple("0.01" for _ in range(100)))
        result = calibrate(_request(100), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(result, Calibrated)

    def test_the_window_is_taken_from_the_end_of_the_series(self) -> None:
        # A parameter set is committed before the session it describes opens, so the only
        # observations available are the ones behind it. Taking the head would calibrate on the
        # oldest data in the series.
        old = tuple("0.001" for _ in range(100))
        recent = tuple("0.05" for _ in range(100))
        bars = bars_from_gaps(old + recent)
        result = calibrate(_request(100), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(result, Calibrated)
        # The recent 5% gaps give a 99th percentile of 5%, so the leverage is about 20, not the
        # hundreds a 0.1% window would give.
        assert result.parameters.lam.raw // WAD < 50

    def test_the_gaussian_and_the_empirical_disagree(self) -> None:
        # Two families, one use case: the family is a parameter of the calibration, not of the
        # pipeline, which is what makes the comparison reproducible.
        gaps = tuple("0.001" for _ in range(590)) + tuple("0.08" for _ in range(10))
        bars = bars_from_gaps(gaps)
        empirical = calibrate(_request(600), bars, FAMILIES["empirical"], reference_keccak)
        gaussian = calibrate(_request(600), bars, FAMILIES["gaussian"], reference_keccak)
        assert isinstance(empirical, Calibrated)
        assert isinstance(gaussian, Calibrated)
        assert empirical.parameters.premium.raw != gaussian.parameters.premium.raw
        assert gaussian.parameters.model == "gaussian"


class TestTheInputsHash:
    def test_the_digest_is_deterministic(self) -> None:
        bars = bars_from_gaps(tuple("0.01" for _ in range(600)))
        first = calibrate(_request(600), bars, FAMILIES["empirical"], reference_keccak)
        second = calibrate(_request(600), bars, FAMILIES["empirical"], reference_keccak)
        assert isinstance(first, Calibrated)
        assert isinstance(second, Calibrated)
        assert first.parameters.inputs_hash == second.parameters.inputs_hash

    def test_the_digest_is_sensitive_to_the_rows(self) -> None:
        first = rows_digest(reference_keccak, bars_from_gaps(("0.01", "0.02")))
        second = rows_digest(reference_keccak, bars_from_gaps(("0.01", "0.03")))
        assert first != second

    def test_the_digest_is_sensitive_to_the_order_of_the_rows(self) -> None:
        # The canonical serialisation is positional, so a reordered window is a different input set.
        # That matters because the window is defined as the last N sessions, and a source that
        # reordered would otherwise produce the same digest for a different fit.
        forward = bars_from_gaps(("0.01", "0.02"))
        reversed_bars = tuple(reversed(forward))
        assert rows_digest(reference_keccak, forward) != rows_digest(
            reference_keccak, reversed_bars
        )

    def test_the_digest_is_sensitive_to_the_close(self) -> None:
        # The digest covers the close as well as the open, because the gap is a ratio and a series
        # scaled by a constant has the same gaps and different rows.
        bars = bars_from_gaps(("0.01",))
        scaled = tuple(
            DailyBar(
                trading_date=bar.trading_date,
                close=Wad(bar.close.raw * 2),
                next_open=Wad(bar.next_open.raw * 2),
            )
            for bar in bars
        )
        assert rows_digest(reference_keccak, bars) != rows_digest(reference_keccak, scaled)


class TestTheRequest:
    def test_a_zero_window_is_refused(self) -> None:
        import pytest

        with pytest.raises(ValueError, match="at least one session"):
            CalibrationRequest(
                symbol=NVDA,
                session=SessionKind.OVERNIGHT,
                window_sessions=0,
                source_ids=SOURCE_IDS,
            )

    def test_a_request_with_no_sources_is_refused(self) -> None:
        # A parameter set has to name the sources its inputs came from, or a challenge cannot
        # reconstruct the input set it is meant to verify.
        import pytest

        with pytest.raises(ValueError, match="sources"):
            CalibrationRequest(
                symbol=NVDA,
                session=SessionKind.OVERNIGHT,
                window_sessions=504,
                source_ids=(),
            )


def _request(window: int) -> CalibrationRequest:
    return CalibrationRequest(
        symbol=NVDA,
        session=SessionKind.OVERNIGHT,
        window_sessions=window,
        source_ids=SOURCE_IDS,
    )
