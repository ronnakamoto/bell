"""The settlement route interface, and the types every route shares.

Five routes, one protocol. The route is a **Strategy** rather than a branch inside one function
because the set is open: the brief's §5.2 names settlement routes as an open set that must be
selectable and comparable at runtime, and the paper's §8.4 compares all five on cost. A single
`if`-chain would make adding a route a change to the settlement path, which is the last place a
change should be.

Each route declares three things beyond its behaviour, and all three are load-bearing for the
comparison the paper makes:

- `expected_cost_bp`, so the choice of route is a stated number rather than a preference.
- `monotone`, because a non-monotone payoff admits a strategy that extracts value from settlement
  rather than from the gap.
- `free_option`, because a route that pays on an absent print writes an option to its own hedgers at
  no premium. That is the defect R1 has and R2 removes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from typing import Protocol

from bell_calibrator.domain.constants import WAD

from bell_settlement.domain.prints import (
    PrintSelected,
    ReferencePrint,
    SelectionResult,
    select_print,
)


class RouteId(StrEnum):
    """The five routes of the paper's §8.4, in the order it compares them."""

    R1 = "R1"
    R2 = "R2"
    R3 = "R3"
    R4 = "R4"
    R5 = "R5"


class SettlementAction(StrEnum):
    """What a route decides to do.

    Four actions rather than two, because "void at half" and "constant refund" are different
    economic objects even though both pay a constant: the first pays unconditionally and the second
    pays only inside a plausibility band, which is exactly why the second has a smaller free option.
    """

    SETTLE_ON_PRINT = "settle_on_print"
    VOID_AT_HALF = "void_at_half"
    CONSTANT_REFUND = "constant_refund"
    DEFER = "defer"


class SettlementBranch(StrEnum):
    """The branch recorded on the settlement. Mirrors the contract's `Branch` enum."""

    LIVE_PRINT = "live_print"
    STALE_PRINT = "stale_print"
    CORPORATE_ACTION_TERMINAL = "corporate_action_terminal"
    VOID_AT_HALF = "void_at_half"
    DEFERRED = "deferred"


@dataclass(frozen=True, slots=True)
class RouteInputs:
    """Everything a route may consult. Passed whole rather than as six parameters.

    The multiplier is carried as a pair rather than as a boolean so that a route can compute the
    *adjusted* gap rather than merely detect that one is needed -- a route that knew only "drifted"
    would have to guess at the adjustment.
    """

    prints: tuple[ReferencePrint, ...]
    not_before: datetime
    now: datetime
    freshness_bound: timedelta
    stale_bound: timedelta
    lam_wad: int
    multiplier_at_registration: Decimal
    multiplier_now: Decimal
    plausibility_band_wad: int
    # Whether a challenge to the committed parameter set is open, and whether a trailing-realised
    # fallback is registered. Both are read only by route R5, and both default to the "nothing
    # disputed" case so that the other four routes need not know about them.
    challenge_open: bool = False
    fallback_registered: bool = False
    @property
    def multiplier_drifted(self) -> bool:
        """Whether the reference token's multiplier moved between registration and settlement.

        A difference of any size counts. The multiplier is an exact quantity rather than a
        measurement: a split or an ex-date moves it by a stated ratio, so a difference of one wei is
        a corporate action rather than noise.
        """
        return self.multiplier_now != self.multiplier_at_registration

    def select(self) -> SelectionResult:
        """The settlement print, or a report that none qualifies."""
        return select_print(
            self.prints,
            not_before=self.not_before,
            now=self.now,
            freshness_bound=self.freshness_bound,
            stale_bound=self.stale_bound,
        )

    def most_recent_gap_wad(self) -> int | None:
        """The gap of the latest print, whether or not it qualifies.

        Used by route R4, which has to distinguish a feed outage from a market event before it
        refunds: a plausible gap suggests the feed stopped, and an implausible one suggests the
        market moved. `None` when nothing has ever been printed.
        """
        if not self.prints:
            return None
        latest = max(candidate.timestamp for candidate in self.prints)
        at_latest = tuple(c for c in self.prints if c.timestamp == latest)
        return min(at_latest, key=lambda c: c.insertion_index).gap_wad

    def adjusted_gap_wad(self, gap_wad: int) -> int:
        """The ex-date adjustment: `(1 + G) * m_registration / m_now - 1`.

        On an ex-date the headline return is not a market move: it contains the distribution, and
        multiplier moves by the same factor, so dividing the gross return by the multiplier's
        movement removes the distribution and leaves the market gap. Paying on the headline would
        record a spurious gap on every ex-date and route it through the live branch, which is what
        guard G8 exists to prevent.
        """
        if self.multiplier_now == 0:
            raise ValueError("a zero multiplier makes the adjusted gap undefined")
        gross = Decimal(WAD + gap_wad)
        adjusted = (gross * self.multiplier_at_registration) / self.multiplier_now
        return int(adjusted) - WAD


@dataclass(frozen=True, slots=True)
class RouteOutcome:
    """What a route decided, and why.

    `payoff_wad` is `None` exactly when the action is a deferral, and the type says so rather than
    the caller having to know. A deferral is the absence of a decision, not a decision that the
    payoff is zero: settling a deferred session on a zero would mint a free claim, which is the
    fail-open the brief forbids in as many words.
    """

    route: RouteId
    action: SettlementAction
    branch: SettlementBranch
    payoff_wad: int | None
    selected: ReferencePrint | None
    cost_bp: Decimal
    rationale: str

    @property
    def settles(self) -> bool:
        """Whether this outcome fixes a payoff."""
        return self.payoff_wad is not None


class SettlementRoute(Protocol):
    """One settlement route.

    A `Protocol` rather than an abstract base class, so a route is any object with these members and
    an adapter can supply one without importing the domain.
    """

    @property
    def identifier(self) -> RouteId:
        """Which route this is."""
        ...

    @property
    def expected_cost_bp(self) -> Decimal | None:
        """The expected cost in basis points of notional per session.

        `None` means the route cannot be priced from the aggregate. R3's cost depends on a name's
        corporate-action calendar rather than on the route, so a single number would be a claim no
        name experiences -- and the report says so rather than quoting an average.
        """
        ...

    @property
    def monotone(self) -> bool:
        """Whether the payoff is monotone in the absolute gap."""
        ...

    @property
    def free_option(self) -> bool:
        """Whether the route pays on an absent print, writing an option at no premium."""
        ...

    def evaluate(self, inputs: RouteInputs) -> RouteOutcome:
        """Evaluate the route against a set of inputs."""
        ...


def payoff_long_wad(lam_wad: int, gap_wad: int) -> int:
    """`min(lambda * |G|, 1)`, the long claim's terminal payoff at WAD scale.

    Mirrors `contracts/src/libraries/Payoff.sol`. A second implementation is a divergence risk, so
    the two are held together by the differential suite rather than by convention -- and this one is
    the reference the contract is checked against.
    """
    magnitude = abs(gap_wad)
    scaled = (lam_wad * magnitude) // WAD
    return min(scaled, WAD)


def settle_on_print(
    inputs: RouteInputs, selection: PrintSelected, *, route: RouteId, cost_bp: Decimal
) -> RouteOutcome:
    """The shared settling path: adjust for a corporate action, then price the gap.

    Every route that settles on a print goes through here, since the multiplier adjustment is guard
    G8 and is not a route's choice. What a route *does* choose is what happens when no print
    qualifies, which is where the five differ and where the cost comparison lives.

    The branch names the corporate action when the multiplier moved, so the settlement record says
    which of the two very different things happened rather than leaving it to be inferred from the
    payoff.
    """
    drift = inputs.multiplier_drifted
    gap_wad = inputs.adjusted_gap_wad(selection.print.gap_wad) if drift else selection.print.gap_wad
    if drift:
        branch = SettlementBranch.CORPORATE_ACTION_TERMINAL
    else:
        branch = SettlementBranch.STALE_PRINT if selection.is_stale else SettlementBranch.LIVE_PRINT
    return RouteOutcome(
        route=route,
        action=SettlementAction.SETTLE_ON_PRINT,
        branch=branch,
        payoff_wad=payoff_long_wad(inputs.lam_wad, gap_wad),
        selected=selection.print,
        cost_bp=cost_bp,
        rationale="a print qualified, so the fallback was not reached",
    )
