"""Session classification by calendar span.

Pure: a span and an announcement flag in, a session kind out. No calendar, no clock.
"""

from __future__ import annotations

from dataclasses import dataclass

from bell_calibrator.domain.models import SessionKind

OVERNIGHT_SPAN_DAYS = 1
WEEKEND_SPAN_DAYS = 3
HOLIDAY_SPANS_DAYS = frozenset({2, 4, 5})


@dataclass(frozen=True, slots=True)
class SessionSpan:
    """The calendar span of a gap, in days, plus whether an announcement falls inside it."""

    calendar_days: int
    contains_scheduled_announcement: bool = False

    def __post_init__(self) -> None:
        if self.calendar_days < OVERNIGHT_SPAN_DAYS:
            raise ValueError("a gap spans at least one calendar day")


def classify(span: SessionSpan) -> SessionKind:
    """Classify a gap into the session taxonomy.

    An announcement session is checked first and short-circuits the span rule. That ordering is the
    whole point of the classification: an announcement gap is `Overnight` by duration and a
    different object by distribution, so a rule that tested the span first would pool it with the
    overnight sample and understate the premium by 4.0 to 16.5% (paper §7.10).

    The spans are the design's own: 1 day is overnight, 3 days is a weekend, everything else is a
    holiday. A 2-day span is a holiday rather than a short weekend, which is a calendar fact rather
    than a choice -- it is a Friday close to a Tuesday open, so a holiday intervened.
    """
    if span.contains_scheduled_announcement:
        return SessionKind.EVENT
    if span.calendar_days == OVERNIGHT_SPAN_DAYS:
        return SessionKind.OVERNIGHT
    if span.calendar_days == WEEKEND_SPAN_DAYS:
        return SessionKind.WEEKEND
    return SessionKind.HOLIDAY


def is_pooled_with_weekend(kind: SessionKind) -> bool:
    """Whether the session's parameters are pooled rather than per-name.

    Overnight is the only session whose per-name estimate is publishable: it has 19.65 expected tail
    observations against 4.52 on a weekend, 0.96 on a holiday and 0.34 in an event session, and a
    weekend's per-name spread of leverage is no larger than its own standard error -- which makes a
    per-name weekend number an estimate of nothing rather than a noisy estimate of something
    (paper §7.8, Table 14).
    """
    return kind is not SessionKind.OVERNIGHT


def expected_tail_observations(observations: int, alpha: float) -> float:
    """`n * alpha`, the quantity that governs whether a per-name quantile can be published.

    Not the sample size: what governs an order statistic is how many observations sit at or beyond
    the quantile being estimated. At `alpha = 1%` that is one observation in a hundred, which is why
    a 126-session weekend window holds roughly one tail draw and cannot locate the quantile at all.

    Note the paper writes this quantity as `n(1 - alpha)` in §7.8 and Table 14, but its own numbers
    are `n * alpha`: 1,965 overnight observations give 19.65, not 1,945.35, and 452 weekend
    observations give 4.52, not 447.48. `alpha` is the saturation probability, i.e. the probability
    of landing in the top per cent, so the expected tail count is `n * alpha` and the paper's
    notation is the slip. The values are used, not the notation.

    `float` is used here and only here: this is a screening count used to choose between estimators,
    never a money or probability quantity that reaches a parameter set.
    """
    return observations * alpha
