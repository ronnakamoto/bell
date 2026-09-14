"""R5: the optimistic challenge window.

Settlement is optimistic -- the first valid print settles it -- and the *parameter set* the pool
priced against can be challenged within a window afterwards. The 1.37 bp per session is the cost of
that window, and the paper's §7.11 puts the mechanism itself in `PremiumRegistry`: a commitment made
before the session opens, a bond on each side, and a deterministic re-run of the committed inputs.

**A finding, stated.** The brief's §4.3 presents R5 as one of five *settlement routes*, but its
settlement rule is R2's. What distinguishes it is a dispute mechanism over the parameter set, which
is not a settlement rule at all -- it changes what the pool prices against, not how a session
resolves. This route therefore settles exactly as R2 does and reports the challenge state in its
rationale, rather than inventing a settlement behaviour the paper does not describe. Recorded as F38
in DESIGN_NOTES.md.

The consequence is worth naming: R5 and R2 are not alternatives. R2 is a settlement route and R5 is
that route plus a pricing-trust mechanism, so a venue choosing between them is choosing whether to
police the parameter set, not how to settle.
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


class OptimisticChallengeRoute:
    """Settle optimistically; the challenge window polices the parameter set, not the settlement."""

    @property
    def identifier(self) -> RouteId:
        return RouteId.R5

    @property
    def expected_cost_bp(self) -> Decimal:
        """1.37 bp per session, measured, and already carried in the settlement budget."""
        return Decimal("1.37")

    @property
    def monotone(self) -> bool:
        """Monotone: the settlement rule is R2's."""
        return True

    @property
    def free_option(self) -> bool:
        """None at settlement. A challenged *parameter* is a pricing question, not a payoff."""
        return False

    def evaluate(self, inputs: RouteInputs) -> RouteOutcome:
        selection = inputs.select()
        if isinstance(selection, PrintSelected):
            return settle_on_print(
                inputs, selection, route=self.identifier, cost_bp=self.expected_cost_bp
            )

        # No print. Whether a challenge is open changes nothing about settlement: a deferral pays
        # nothing in either case, which is what makes the free option absent rather than reduced.
        if inputs.challenge_open and not inputs.fallback_registered:
            rationale = (
                "no print qualified, and the commitment is challenged with no fallback registered, "
                "so the pool has nothing to price on; the session stays expired"
            )
        elif inputs.challenge_open:
            rationale = (
                "no print qualified while a challenge is open; the pool prices on the registered "
                "fallback and the session stays expired"
            )
        else:
            rationale = "no print qualified; the session stays expired until one does"

        return RouteOutcome(
            route=self.identifier,
            action=SettlementAction.DEFER,
            branch=SettlementBranch.DEFERRED,
            payoff_wad=None,
            selected=None,
            cost_bp=self.expected_cost_bp,
            rationale=rationale,
        )
