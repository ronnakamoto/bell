"""R1: void at half.

The intuitive fallback. When no print qualifies, both legs are refunded at half value.

**It must never ship.** Paying half on an absent print writes a free long butterfly struck at `c/2`
to the protocol's own hedgers: a long holder receives half whenever the settlement feed fails,
whatever the gap would have been. The paper measures the defect at 29.7 basis points of notional per
session, or 14.3% of the premium paid. Route R2 removes it *exactly*, at a cost of 0.021 bp -- a
factor of about 1,400 between the defect and the fix, which is why the paper excludes R1 by test
rather than by preference.

The route is implemented rather than omitted because the comparison has to be reproducible. A
rejected alternative that no longer exists cannot be re-measured.
"""

from __future__ import annotations

from decimal import Decimal

from bell_calibrator.domain.constants import WAD

from bell_settlement.domain.prints import PrintSelected
from bell_settlement.domain.routes.base import (
    RouteId,
    RouteInputs,
    RouteOutcome,
    SettlementAction,
    SettlementBranch,
    settle_on_print,
)


class VoidAtHalfRoute:
    """Refund both legs at half when no print qualifies."""

    @property
    def identifier(self) -> RouteId:
        return RouteId.R1

    @property
    def expected_cost_bp(self) -> Decimal:
        """29.7 bp per session, measured."""
        return Decimal("29.7")

    @property
    def monotone(self) -> bool:
        """Not monotone: the refund does not depend on the gap at all."""
        return False

    @property
    def free_option(self) -> bool:
        """Yes, and that is the whole objection to it."""
        return True

    def evaluate(self, inputs: RouteInputs) -> RouteOutcome:
        selection = inputs.select()
        if isinstance(selection, PrintSelected):
            return settle_on_print(
                inputs, selection, route=self.identifier, cost_bp=self.expected_cost_bp
            )
        return RouteOutcome(
            route=self.identifier,
            action=SettlementAction.VOID_AT_HALF,
            branch=SettlementBranch.VOID_AT_HALF,
            payoff_wad=WAD // 2,
            selected=None,
            cost_bp=self.expected_cost_bp,
            rationale="no print qualified, so both legs are refunded at half",
        )
