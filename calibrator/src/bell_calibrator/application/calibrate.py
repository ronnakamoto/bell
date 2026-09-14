"""The calibration use case.

One function, four steps, in the order the brief's §4.2 lists them: estimate the leverage on the
session's own window, fit the premium, publish a parameter set, and commit it before the session
opens. The commit is `application/publish.py`; this module produces the parameter set it commits.

Everything here is a *use case* rather than domain: it sequences the domain's pieces and it touches
nothing. The bars arrive as a sequence of value objects, the family arrives as a strategy, and the
hash arrives as a port -- so the whole function is callable with literals, which is the brief's test
for whether something belongs in this layer rather than in `domain/`.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from bell_calibrator.domain import constants
from bell_calibrator.domain.digest import inputs_hash
from bell_calibrator.domain.families import SEED_FAMILY, DistributionFamily, GapSample
from bell_calibrator.domain.families.base import FamilyFit
from bell_calibrator.domain.leverage import lattice_leverage
from bell_calibrator.domain.models import (
    Calibrated,
    DailyBar,
    InsufficientSample,
    ParameterSet,
    SessionKind,
    Symbol,
    Wad,
)
from bell_calibrator.domain.ports import Keccak

#: The saturation probability as an exact ratio rather than a float. The screen below compares
#: `n * alpha` against a threshold, and doing it in integers means the boundary is exact -- a float
#: would put a sample of exactly the required size on the wrong side roughly half the time.
_ALPHA_WAD = constants.ALPHA_WAD
_WAD = constants.WAD

#: One tail observation is the minimum that can place a quantile at all. The paper's §7.8 frames the
#: governing quantity as `n * alpha` -- 19.65 overnight, 4.52 on a weekend, 0.96 on a holiday -- and
#: holiday window below one is exactly why holidays are pooled rather than calibrated per name.
DEFAULT_MINIMUM_TAIL_OBSERVATIONS_WAD = _WAD


@dataclass(frozen=True, slots=True)
class CalibrationRequest:
    """What to calibrate, over which window, with which family.

    A parameter object rather than six arguments, per the brief's §8.1 rule that a function taking
    more than five parameters should take one.
    """

    symbol: Symbol
    session: SessionKind
    window_sessions: int
    source_ids: tuple[str, ...]
    family_name: str = SEED_FAMILY
    minimum_tail_observations_wad: int = DEFAULT_MINIMUM_TAIL_OBSERVATIONS_WAD

    def __post_init__(self) -> None:
        if self.window_sessions <= 0:
            raise ValueError("a calibration window needs at least one session")
        if not self.source_ids:
            raise ValueError("a parameter set has to name the sources its inputs came from")


#: A calibration either produced a parameter set or could not, and the second is a domain result
#: rather than an exception: "the sample cannot support an estimate" is ordinary.
CalibrationResult = Calibrated | InsufficientSample


def calibrate(
    request: CalibrationRequest,
    bars: tuple[DailyBar, ...],
    family: DistributionFamily,
    keccak: Keccak,
) -> CalibrationResult:
    """Estimate the leverage and fit the premium for one `(name, session)`.

    The window is taken from the *end* of the series, since a parameter set is committed before the
    session it describes opens and the only observations available are the ones behind it. Taking
    head would calibrate on the oldest data in the series.
    """
    if len(bars) < request.window_sessions:
        return InsufficientSample(
            symbol=request.symbol,
            session=request.session,
            observations=len(bars),
            required_tail_observations=request.window_sessions,
        )

    window = bars[len(bars) - request.window_sessions :]
    sample = GapSample(gaps_wad=tuple(bar.gap().raw for bar in window))

    if sample.count * _ALPHA_WAD < request.minimum_tail_observations_wad:
        # The screen that makes holidays pooled rather than per-name. It is a screen on the *tail
        # count* and not on the sample size, because what governs an order statistic is how many
        # observations sit at or beyond the quantile being estimated.
        return InsufficientSample(
            symbol=request.symbol,
            session=request.session,
            observations=sample.count,
            required_tail_observations=request.minimum_tail_observations_wad // _ALPHA_WAD,
        )

    lam_wad = _estimate_leverage(sample)
    fit: FamilyFit = family.fit(lam_wad, sample)

    return Calibrated(
        parameters=ParameterSet(
            symbol=request.symbol,
            session=request.session,
            lam=Wad(lam_wad),
            premium=Wad(fit.premium_wad),
            inputs_hash=inputs_hash(
                keccak,
                request.window_sessions,
                request.session,
                request.source_ids,
                sample.count,
                rows_digest(keccak, window),
            ),
            model=family.name,
        )
    )


def _estimate_leverage(sample: GapSample) -> int:
    """`floor(1 / cap)`, with the cap rounded up to the published lattice first.

    The lattice step is not optional and it is not cosmetic: the same measured quantile publishes
    three different leverages on a 1%, a 0.5% and a 0.25% grid, so an unstated grid is an unstated
    instrument. The grid is stated in `spec/constants.yaml` and the round-up direction is the one
    paper's published values reproduce.
    """
    quantile = sample.quantile_magnitude_wad(_one_minus_alpha())
    return lattice_leverage(
        Wad(quantile), Wad(constants.ROUNDING_LATTICE_WAD)
    ).raw


def _one_minus_alpha() -> Decimal:
    """`1 - alpha`, from the exact integer constant.

    Built from the WAD constant rather than written as `0.99`, so that changing `alpha` in
    `spec/constants.yaml` changes the quantile the leverage rule reads. The subtraction happens in
    integers and only the division is decimal, so the value is exact rather than approximately 0.99.
    """
    return Decimal(_WAD - _ALPHA_WAD) / Decimal(_WAD)


def rows_digest(keccak: Keccak, window: tuple[DailyBar, ...]) -> bytes:
    """The digest of the rows a fit consumed.

    Canonical, and deliberately the *minimal* sufficient serialisation: the date, the close and the
    next open, each at WAD scale, in the order the window holds them. A challenger has to be able to
    reproduce this from the same inputs, so anything not part of the gap -- a volume, a high,
    a low -- is excluded rather than carried along.
    """
    payload = bytearray()
    for bar in window:
        payload += bar.trading_date.toordinal().to_bytes(4, "big")
        payload += bar.close.raw.to_bytes(32, "big")
        payload += bar.next_open.raw.to_bytes(32, "big")
    return keccak(bytes(payload))


def window_for(session: SessionKind, symbol: Symbol) -> int:
    """The calibration window for a session, in sessions.

    Chosen by forward error in the paper's §7.9 rather than by intuition, and the two facts worth
    carrying are that longer is better on the overnight session and that the weekend sample cannot
    support a per-name window at all. AAPL's overnight window is 378 not 504, which is the one
    per-name exception the paper records.
    """
    if session is SessionKind.OVERNIGHT:
        if symbol.text == "AAPL":
            return constants.OVERNIGHT_WINDOW_SESSIONS_AAPL
        return constants.OVERNIGHT_WINDOW_SESSIONS
    if session in (SessionKind.WEEKEND, SessionKind.HOLIDAY):
        return constants.WEEKEND_WINDOW_SESSIONS
    raise ValueError(
        f"the {session} session has no pooled window; event sessions are calibrated per name"
    )

