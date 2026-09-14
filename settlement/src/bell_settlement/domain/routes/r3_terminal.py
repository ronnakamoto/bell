"""R3: the corporate-action-adjusted terminal branch.

When the reference token's multiplier has moved between registration and settlement, the headline
return is not a market move. This route settles on the *adjusted* gap and records the terminal
corporate-action branch, so an ex-date changes the branch rather than printing a gap.

**An interpretation, stated.** The paper's §8.4 gives R3's cost as name-specific and describes it as
the corporate-action-adjusted terminal branch, without specifying what it does when no print
qualifies. The reading implemented here is that a drifted reference has no future print to defer to
-- the corporate action is the terminal event, and the feed's behaviour after it is not something
settlement can wait on -- so the route voids at half when the multiplier has drifted and defers when
it has not. Recorded as F37 in DESIGN_NOTES.md.

The cost is therefore not a single number. A route whose cost depends on a name's corporate-action
calendar cannot be priced from the aggregate, and the honest report says so rather than quoting an
average that no name experiences.
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


class CorporateActionTerminalRoute:
    """Settle on the adjusted gap; void when a drifted reference has no print."""

    @property
    def identifier(self) -> RouteId:
        return RouteId.R3

    @property
    def expected_cost_bp(self) -> Decimal | None:
        """Not quotable as a single number, and the type says so.

        The cost is the probability that a print fails to arrive between a corporate action and the
        next settlement, which is a property of the name's calendar rather than of the route. A zero
        here would be a claim the route cannot make; `cost_report` reports it as unquotable and the
        caller has to say which name it means.
        """
        return None

    @property
    def monotone(self) -> bool:
        """Monotone: the adjusted gap is still a gap."""
        return True

    @property
    def free_option(self) -> bool:
        """None. The void branch is reachable only when the reference has terminated."""
        return False

    def evaluate(self, inputs: RouteInputs) -> RouteOutcome:
        selection = inputs.select()
        if isinstance(selection, PrintSelected):
            return settle_on_print(inputs, selection, route=self.identifier, cost_bp=Decimal(0))
        if inputs.multiplier_drifted:
            return RouteOutcome(
                route=self.identifier,
                action=SettlementAction.VOID_AT_HALF,
                branch=SettlementBranch.CORPORATE_ACTION_TERMINAL,
                payoff_wad=WAD // 2,
                selected=None,
                cost_bp=Decimal(0),
                rationale=(
                    "the reference terminated and no print arrived; there is no future print to "
                    "defer to, so the terminal branch pays half"
                ),
            )
        return RouteOutcome(
            route=self.identifier,
            action=SettlementAction.DEFER,
            branch=SettlementBranch.DEFERRED,
            payoff_wad=None,
            selected=None,
            cost_bp=Decimal(0),
            rationale="no print and no corporate action; the session stays expired",
        )
