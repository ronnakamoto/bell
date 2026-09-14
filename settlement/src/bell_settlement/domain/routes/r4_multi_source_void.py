"""R4: constant refund with a plausibility band.

Refund both legs at half, but only when the most recent print looks like a *feed outage* rather than
a market event: the refund is paid when the latest gap is inside the plausibility band, and the
defers when it is outside.

That conditionality is the whole difference between R4 and R1, and it is what makes R4's free option
*reduced* rather than absent. R1 pays half whatever the gap would have been, so a holder receives a
windfall on every settlement failure; R4 pays half only when the failure is consistent with the feed
having stopped, so a large move -- the case a hedger actually bought the instrument for -- is not
refunded at a fixed price. The paper measures the defect at 1.37 bp against R1's 29.7 bp.

**An interpretation, stated.** The paper describes R4 as "constant refund with a plausibility band"
and gives its cost, without defining the band or the constant. The reading implemented here is the
one that reproduces the *shape* the paper reports -- a reduced rather than absent free option, at a
cost between R2's and R1's -- and it is recorded as F37 in DESIGN_NOTES.md. The constant is half,
matching R1, because a refund at any other value would make R4 a different instrument rather than a
conditional version of the same one.
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


class PlausibilityRefundRoute:
    """Refund at half when the latest print is plausible; defer when it is not."""

    @property
    def identifier(self) -> RouteId:
        return RouteId.R4

    @property
    def expected_cost_bp(self) -> Decimal:
        """1.37 bp per session, measured."""
        return Decimal("1.37")

    @property
    def monotone(self) -> bool:
        """Not monotone: the refund does not depend on the settled gap."""
        return False

    @property
    def free_option(self) -> bool:
        """Reduced rather than absent. Present, so the answer is yes."""
        return True

    def evaluate(self, inputs: RouteInputs) -> RouteOutcome:
        selection = inputs.select()
        if isinstance(selection, PrintSelected):
            return settle_on_print(
                inputs, selection, route=self.identifier, cost_bp=self.expected_cost_bp
            )

        latest_gap = inputs.most_recent_gap_wad()
        plausible = latest_gap is not None and abs(latest_gap) <= inputs.plausibility_band_wad
        if not plausible:
            return RouteOutcome(
                route=self.identifier,
                action=SettlementAction.DEFER,
                branch=SettlementBranch.DEFERRED,
                payoff_wad=None,
                selected=None,
                cost_bp=self.expected_cost_bp,
                rationale=(
                    "no print qualified and the latest one is outside the plausibility band, which "
                    "is a market event rather than a feed outage; the refund is not paid"
                ),
            )
        return RouteOutcome(
            route=self.identifier,
            action=SettlementAction.CONSTANT_REFUND,
            branch=SettlementBranch.VOID_AT_HALF,
            payoff_wad=WAD // 2,
            selected=None,
            cost_bp=self.expected_cost_bp,
            rationale="no print qualified but the feed looks merely stopped, so the refund is paid",
        )
