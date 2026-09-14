"""R2: deferred settlement on the first valid print.

The recommended architecture. When no print qualifies, nothing is settled: the session stays
`Expired` and the first qualifying print settles it whenever it arrives.

The cost is 0.021 bp per session, and the free option is removed **exactly** rather than reduced --
not because the deferral is cheap, but because it is not an option at all. A deferral fixes no
payoff, so there is no state of the world in which a holder receives a payment that was not earned.
R1's 29.7 bp is the price of a payment on an absent print; R2's 0.021 bp is the price of waiting.

The one cost that is real: a deferred session cannot be claimed against, so capital stays locked for
as long as the feed is down. That is a liveness cost rather than an economic one, and it is bounded
by the fact that a feed which never returns is a terminal event the paper's §12.2 treats separately.
"""

from __future__ import annotations

from decimal import Decimal

from bell_settlement.domain.prints import PrintSelected
from bell_settlement.domain.routes.base import (
    RouteId,
    RouteInputs,
    RouteOutcome,
    SettlementAction,
    SettlementBranch,
    settle_on_print,
)


class DeferredSettlementRoute:
    """Defer when no print qualifies, and settle on the first one that does."""

    @property
    def identifier(self) -> RouteId:
        return RouteId.R2

    @property
    def expected_cost_bp(self) -> Decimal:
        """0.021 bp per session, measured."""
        return Decimal("0.021")

    @property
    def monotone(self) -> bool:
        """Monotone: the payoff is the payoff function, evaluated later."""
        return True

    @property
    def free_option(self) -> bool:
        """None at all. A deferral pays nothing, so there is nothing to extract."""
        return False

    def evaluate(self, inputs: RouteInputs) -> RouteOutcome:
        selection = inputs.select()
        if isinstance(selection, PrintSelected):
            return settle_on_print(
                inputs, selection, route=self.identifier, cost_bp=self.expected_cost_bp
            )
        return RouteOutcome(
            route=self.identifier,
            action=SettlementAction.DEFER,
            branch=SettlementBranch.DEFERRED,
            payoff_wad=None,
            selected=None,
            cost_bp=self.expected_cost_bp,
            rationale="no print qualified; the session stays expired until one does",
        )
