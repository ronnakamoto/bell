"""The five settlement routes.

Each route is tested in both directions: what it does when a print qualifies, and what it does when
none does. The second is where the five differ and where the cost comparison lives, so a route that
has only been tested with a print present is a route whose distinguishing behaviour is unverified.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from bell_calibrator.domain.constants import WAD

from bell_settlement.domain.prints import ReferencePrint
from bell_settlement.domain.routes import (
    EXCLUDED_ROUTE,
    RECOMMENDED_ROUTE,
    ROUTES,
    cheapest_shipping_route,
    cost_report,
    route_for,
)
from bell_settlement.domain.routes.base import (
    RouteId,
    RouteInputs,
    SettlementAction,
    SettlementBranch,
    payoff_long_wad,
)

EXPIRY = datetime(2026, 9, 14, 13, 30, tzinfo=UTC)
FRESHNESS = timedelta(minutes=10)
STALENESS = timedelta(hours=2)
#: One second past the staleness bound, which is where the fallback branches are reachable. A print
#: exactly *at* the bound still qualifies, so a test using it would silently settle instead.
BEYOND_STALENESS = EXPIRY + STALENESS + timedelta(seconds=1)
LAM = 15 * WAD
PLAUSIBILITY_BAND = int(Decimal("0.25") * WAD)


def a_print(gap: str, *, seconds_after_expiry: int = 0, index: int = 0) -> ReferencePrint:
    return ReferencePrint(
        source="primary",
        priority=1,
        timestamp=EXPIRY + timedelta(seconds=seconds_after_expiry),
        gap_wad=int(Decimal(gap) * WAD),
        insertion_index=index,
    )


def inputs(
    prints: tuple[ReferencePrint, ...] = (),
    *,
    now: datetime | None = None,
    drifted: bool = False,
    challenge_open: bool = False,
    fallback_registered: bool = False,
) -> RouteInputs:
    return RouteInputs(
        prints=prints,
        not_before=EXPIRY,
        now=now or EXPIRY,
        freshness_bound=FRESHNESS,
        stale_bound=STALENESS,
        lam_wad=LAM,
        multiplier_at_registration=Decimal("1"),
        multiplier_now=Decimal("0.98") if drifted else Decimal("1"),
        plausibility_band_wad=PLAUSIBILITY_BAND,
        challenge_open=challenge_open,
        fallback_registered=fallback_registered,
    )


class TestRouteSet:
    def test_every_route_is_registered(self) -> None:
        assert set(ROUTES) == set(RouteId)

    def test_every_route_reports_its_own_identifier(self) -> None:
        for identifier, route in ROUTES.items():
            assert route.identifier is identifier

    def test_the_recommended_route_is_the_cheapest_shipping_one(self) -> None:
        # The recommendation has to be the arithmetic outcome, not a preference. If a cheaper route
        # ever ships, this test fails and the recommendation has to be re-argued.
        assert cheapest_shipping_route() is RECOMMENDED_ROUTE

    def test_the_excluded_route_is_the_most_expensive(self) -> None:
        costs: list[tuple[Decimal, RouteId]] = [
            (row.cost_bp, row.identifier) for row in cost_report() if row.cost_bp is not None
        ]
        assert costs
        _, worst_identifier = max(costs)
        assert worst_identifier is EXCLUDED_ROUTE
        assert route_for(worst_identifier).free_option, "and it is the one with the free option"

    def test_the_cost_report_orders_by_identifier_and_marks_the_shipper(self) -> None:
        report = cost_report()
        assert [row.identifier for row in report] == sorted(RouteId)
        assert [row.identifier for row in report if row.ships] == [RECOMMENDED_ROUTE]

    def test_the_cost_report_does_not_quote_an_unquotable_route(self) -> None:
        # R3's cost is a property of a name's calendar, not of the route. A zero would be a claim no
        # name experiences.
        row = next(row for row in cost_report() if row.identifier is RouteId.R3)
        assert row.cost_bp is None

    def test_route_for_refuses_an_unknown_identifier(self) -> None:
        with pytest.raises(KeyError):
            route_for("R9")  # type: ignore[arg-type]


class TestSettlingOnAPrint:
    """All five routes settle on a qualifying print, through one shared path."""

    @pytest.mark.parametrize("identifier", list(RouteId))
    def test_a_qualifying_print_settles_every_route(self, identifier: RouteId) -> None:
        outcome = route_for(identifier).evaluate(inputs((a_print("0.02"),)))
        assert outcome.action is SettlementAction.SETTLE_ON_PRINT
        assert outcome.payoff_wad == payoff_long_wad(LAM, int(Decimal("0.02") * WAD))
        assert outcome.settles

    @pytest.mark.parametrize("identifier", list(RouteId))
    def test_a_stale_print_settles_on_the_stale_branch(self, identifier: RouteId) -> None:
        late = EXPIRY + FRESHNESS + timedelta(seconds=1)
        outcome = route_for(identifier).evaluate(inputs((a_print("0.02"),), now=late))
        assert outcome.branch is SettlementBranch.STALE_PRINT

    @pytest.mark.parametrize("identifier", list(RouteId))
    def test_a_corporate_action_routes_to_the_terminal_branch(self, identifier: RouteId) -> None:
        # Guard G8 is not a route's choice, so every settling route applies it.
        outcome = route_for(identifier).evaluate(inputs((a_print("-0.02"),), drifted=True))
        assert outcome.branch is SettlementBranch.CORPORATE_ACTION_TERMINAL
        assert outcome.payoff_wad == 0, "a full adjustment removes the spurious gap entirely"

    @pytest.mark.parametrize("identifier", list(RouteId))
    def test_a_negative_gap_settles_as_its_magnitude(self, identifier: RouteId) -> None:
        # The payoff is even in the gap, so refusing one sign would halve the instrument.
        positive = route_for(identifier).evaluate(inputs((a_print("0.02"),)))
        negative = route_for(identifier).evaluate(inputs((a_print("-0.02"),)))
        assert positive.payoff_wad == negative.payoff_wad


class TestTheFallbackBranches:
    """Where the five differ, and where the cost comparison lives."""

    def test_r1_voids_at_half_unconditionally(self) -> None:
        outcome = route_for(RouteId.R1).evaluate(inputs())
        assert outcome.action is SettlementAction.VOID_AT_HALF
        assert outcome.branch is SettlementBranch.VOID_AT_HALF
        assert outcome.payoff_wad == WAD // 2

    def test_r1_voids_at_half_however_large_the_last_gap_was(self) -> None:
        # The defect: R1 pays half whatever the gap would have been, so the refund does not depend
        # on the gap at all. This is the free option the paper prices at 29.7 bp.
        small = route_for(RouteId.R1).evaluate(inputs((a_print("0.001"),), now=BEYOND_STALENESS))
        large = route_for(RouteId.R1).evaluate(inputs((a_print("0.20"),), now=BEYOND_STALENESS))
        assert small.payoff_wad == large.payoff_wad == WAD // 2

    def test_r2_defers_and_pays_nothing(self) -> None:
        outcome = route_for(RouteId.R2).evaluate(inputs())
        assert outcome.action is SettlementAction.DEFER
        assert outcome.branch is SettlementBranch.DEFERRED
        assert outcome.payoff_wad is None, "a deferral is the absence of a decision"
        assert not outcome.settles

    def test_r3_voids_at_half_when_a_drifted_reference_has_no_print(self) -> None:
        outcome = route_for(RouteId.R3).evaluate(inputs(drifted=True))
        assert outcome.action is SettlementAction.VOID_AT_HALF
        assert outcome.branch is SettlementBranch.CORPORATE_ACTION_TERMINAL

    def test_r3_defers_when_nothing_has_drifted(self) -> None:
        outcome = route_for(RouteId.R3).evaluate(inputs())
        assert outcome.action is SettlementAction.DEFER

    def test_r4_refunds_when_the_feed_merely_stopped(self) -> None:
        # A plausible last print is consistent with the feed having stopped, so the refund is paid.
        outcome = route_for(RouteId.R4).evaluate(
            inputs((a_print("0.01"),), now=BEYOND_STALENESS)
        )
        assert outcome.action is SettlementAction.CONSTANT_REFUND
        assert outcome.payoff_wad == WAD // 2

    def test_r4_defers_when_the_last_print_is_implausible(self) -> None:
        # An implausible last print is a market event rather than a feed outage, and paying half on
        # a
        # market event is exactly the free option R4 exists to reduce.
        outcome = route_for(RouteId.R4).evaluate(
            inputs((a_print("0.40"),), now=BEYOND_STALENESS)
        )
        assert outcome.action is SettlementAction.DEFER
        assert outcome.payoff_wad is None

    def test_r4_defers_when_nothing_has_ever_been_printed(self) -> None:
        outcome = route_for(RouteId.R4).evaluate(inputs())
        assert outcome.action is SettlementAction.DEFER

    def test_r5_defers_and_names_the_challenge_state(self) -> None:
        plain = route_for(RouteId.R5).evaluate(inputs())
        challenged = route_for(RouteId.R5).evaluate(inputs(challenge_open=True))
        assert plain.action is challenged.action is SettlementAction.DEFER
        assert plain.payoff_wad is challenged.payoff_wad is None
        assert "challenge" in challenged.rationale
        assert "challenge" not in plain.rationale

    def test_r5_distinguishes_a_challenged_commitment_with_a_fallback(self) -> None:
        """The third state: challenged *and* a trailing-realised fallback registered.

        R5's rationale has three cases and the test above reaches two of them -- no challenge, and a
        challenge with no fallback. The middle one is the state the fallback mechanism exists to
        produce: the commitment is under dispute, so the pool cannot price on it, but a registered
        fallback means it can price on something rather than halting. All three defer, so the payoff
        cannot tell them apart; the rationale is the only thing that can, so it is what is
        asserted.
        """
        with_fallback = route_for(RouteId.R5).evaluate(
            inputs(challenge_open=True, fallback_registered=True)
        )
        without_fallback = route_for(RouteId.R5).evaluate(inputs(challenge_open=True))

        assert with_fallback.action is SettlementAction.DEFER
        assert with_fallback.payoff_wad is None
        assert "fallback" in with_fallback.rationale
        assert with_fallback.rationale != without_fallback.rationale

    def test_the_adjusted_gap_refuses_a_zero_multiplier(self) -> None:
        """The ex-date adjustment divides by the current multiplier, so a zero leaves it undefined.

        `RouteInputs` does not refuse a zero at construction: a route that never asks for the
        adjusted gap should not be made to care, and the four routes that do not are the majority.
        The refusal belongs where the division is.
        """
        zeroed = replace(inputs(drifted=True), multiplier_now=Decimal(0))
        with pytest.raises(ValueError, match="zero multiplier"):
            zeroed.adjusted_gap_wad(WAD)


class TestRouteDeclarations:
    def test_the_published_costs_are_reproduced(self) -> None:
        assert route_for(RouteId.R1).expected_cost_bp == Decimal("29.7")
        assert route_for(RouteId.R2).expected_cost_bp == Decimal("0.021")
        assert route_for(RouteId.R3).expected_cost_bp is None
        assert route_for(RouteId.R4).expected_cost_bp == Decimal("1.37")
        assert route_for(RouteId.R5).expected_cost_bp == Decimal("1.37")

    def test_only_the_void_routes_carry_a_free_option(self) -> None:
        assert route_for(RouteId.R1).free_option
        assert route_for(RouteId.R4).free_option
        assert not route_for(RouteId.R2).free_option
        assert not route_for(RouteId.R3).free_option
        assert not route_for(RouteId.R5).free_option

    def test_the_non_monotone_routes_are_the_refunding_ones(self) -> None:
        # A refund that does not depend on the gap is not monotone in the gap, which is what admits
        # a
        # strategy that extracts value from settlement rather than from the gap.
        assert not route_for(RouteId.R1).monotone
        assert not route_for(RouteId.R4).monotone
        assert route_for(RouteId.R2).monotone
        assert route_for(RouteId.R3).monotone
        assert route_for(RouteId.R5).monotone


class TestPayoffPrimitive:
    def test_the_payoff_is_capped_at_the_collateral_unit(self) -> None:
        assert payoff_long_wad(LAM, WAD) == WAD
        assert payoff_long_wad(LAM, 10 * WAD) == WAD

    def test_the_payoff_is_linear_below_the_cap(self) -> None:
        assert payoff_long_wad(LAM, int(Decimal("0.02") * WAD)) == int(Decimal("0.30") * WAD)

    def test_the_payoff_saturates_at_the_reciprocal_of_the_leverage(self) -> None:
        # |G| >= 1/lambda is exactly where the cap binds, which is the property the leverage rule is
        # built on.
        # `ceil(1/lambda)`, not `floor(1/lambda)`: the floor sits one wei below the true crossing,
        # where the payoff is still short of the cap. The same one-wei boundary DESIGN_NOTES.md F13
        # records for the contract's `saturationGapWad`.
        threshold = (WAD * WAD + LAM - 1) // LAM
        assert payoff_long_wad(LAM, threshold - 1) < WAD
        assert payoff_long_wad(LAM, threshold) == WAD

    def test_the_payoff_is_even(self) -> None:
        assert payoff_long_wad(LAM, 12345) == payoff_long_wad(LAM, -12345)
