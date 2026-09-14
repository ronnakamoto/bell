"""The route registry, and the cost report.

Five routes behind one interface, selectable and comparable at runtime. The registry is a plain
mapping rather than a factory: a route is stateless, so constructing one per call buys nothing, and
mapping makes the set enumerable -- which is what "the others must remain selectable so the
comparison is reproducible" actually requires.

The cost report is the brief's §4.3 item 4: *"Report the cost of each route, in basis points per
session, so the choice of route is a stated number rather than a preference."* It reports R3 as
unquotable rather than as zero, because a number no name experiences is worse than an absent one.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from bell_settlement.domain.routes.base import RouteId, SettlementRoute
from bell_settlement.domain.routes.r1_void import VoidAtHalfRoute
from bell_settlement.domain.routes.r2_deferred import DeferredSettlementRoute
from bell_settlement.domain.routes.r3_terminal import CorporateActionTerminalRoute
from bell_settlement.domain.routes.r4_multi_source_void import PlausibilityRefundRoute
from bell_settlement.domain.routes.r5_optimistic import OptimisticChallengeRoute

#: Every route, by identifier. Built once at import, because a route holds no state.
ROUTES: Mapping[RouteId, SettlementRoute] = {
    RouteId.R1: VoidAtHalfRoute(),
    RouteId.R2: DeferredSettlementRoute(),
    RouteId.R3: CorporateActionTerminalRoute(),
    RouteId.R4: PlausibilityRefundRoute(),
    RouteId.R5: OptimisticChallengeRoute(),
}

#: The route the paper recommends, and the one that ships. Named rather than written as a literal at
#: each call site, so that "which route is the default" is answerable in one place.
RECOMMENDED_ROUTE: RouteId = RouteId.R2

#: The route the paper excludes by test rather than by preference.
EXCLUDED_ROUTE: RouteId = RouteId.R1


def route_for(identifier: RouteId) -> SettlementRoute:
    """The route with this identifier."""
    return ROUTES[identifier]


@dataclass(frozen=True, slots=True)
class RouteCost:
    """One row of the cost report."""

    identifier: RouteId
    cost_bp: Decimal | None
    monotone: bool
    free_option: bool
    ships: bool


def cost_report() -> tuple[RouteCost, ...]:
    """The cost of every route, in basis points of notional per session.

    `cost_bp` is `None` for a route whose cost is name-specific, which is R3. The report is a tuple
    rather than a mapping so that it has an order -- the order the paper compares them in -- and so
    that it cannot be mutated by a caller that wants a different ranking.
    """
    return tuple(
        RouteCost(
            identifier=identifier,
            cost_bp=route.expected_cost_bp,
            monotone=route.monotone,
            free_option=route.free_option,
            ships=identifier is RECOMMENDED_ROUTE,
        )
        for identifier, route in sorted(ROUTES.items())
    )


def cheapest_shipping_route() -> RouteId:
    """The cheapest route that ships, which is the one the design should select.

    Raises rather than returning a default when nothing ships, because a default here would be a
    settlement route chosen by absence.
    """
    quotable: list[tuple[Decimal, RouteId]] = []
    for row in cost_report():
        if row.ships and row.cost_bp is not None:
            quotable.append((row.cost_bp, row.identifier))
    if not quotable:
        raise RuntimeError("no shipping route has a quotable cost")
    return min(quotable)[1]
