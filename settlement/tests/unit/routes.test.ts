/**
 * The five settlement routes.
 *
 * Ported from `settlement/tests/unit/test_routes.py`. The Python has 29 test functions; four of them
 * are `@pytest.mark.parametrize`d over the five route identifiers, so it runs **45** cases, and so
 * does this file — `describe.each` expands the same way rather than looping inside one test, which
 * keeps a failure attributable to one route.
 *
 * Each route is tested in both directions: what it does when a print qualifies, and what it does when
 * none does. The second is where the five differ and where the cost comparison lives, so a route that
 * has only been tested with a print present is a route whose distinguishing behaviour is unverified.
 *
 * **Three departures, all forced.**
 *
 *  - A timestamp is a `bigint` count of Unix seconds; the bounds are `600n` and `7200n`. Nothing here
 *    converts a date.
 *  - `RouteInputs` is constructed from a named field object, so the Python's
 *    `dataclasses.replace(inputs(drifted=True), multiplier_now=Decimal(0))` becomes a spread over the
 *    same field builder. That is the port's nearest equivalent to `replace`, and it is why the
 *    builder is split out from the constructor call rather than inlined into it.
 *  - `Decimal` has no `==` in JavaScript, so every cost assertion goes through `equals`. `29.7 ==
 *    "29.7"` is `true` in Python and `false` in JavaScript; a test written with `toBe` would pass on
 *    identical object identity and fail on an equal value, which is the worst of both.
 *
 * `routeFor('R9')` is reached through an `as RouteId` assertion, which is the port's `# type:
 * ignore[arg-type]`. The refusal is worth keeping and worth testing even though the type system makes
 * it unreachable from typed code, because an identifier that arrives from a configuration file or a
 * request is a `string` wearing a `RouteId`'s name — and the assertion is exactly where that is
 * acknowledged rather than hidden.
 */

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { WAD } from '@bell/calibrator/domain/constants.js';
import { Wad } from '@bell/calibrator/domain/models.js';

import { ReferencePrint } from '../../src/domain/prints.js';
import {
  RouteId,
  ROUTE_IDS,
  type RouteInputFields,
  RouteInputs,
  type SettlementRoute,
  SettlementAction,
  SettlementBranch,
} from '../../src/domain/routes/base.js';
import { payoffLongWad } from '../../src/domain/routes/settle.js';
import {
  EXCLUDED_ROUTE,
  RECOMMENDED_ROUTE,
  ROUTES,
  cheapestShippingRoute,
  costReport,
  routeFor,
} from '../../src/domain/routes/index.js';

/** `2026-09-14T13:30:00Z`. */
const EXPIRY = 1_789_392_600n;

/** Ten minutes. */
const FRESHNESS = 600n;

/** Two hours. */
const STALENESS = 7_200n;

/**
 * One second past the staleness bound, which is where the fallback branches are reachable.
 *
 * A print exactly *at* the bound still qualifies, so a test using it would silently settle instead —
 * which is why the bound is asserted separately in `prints.test.ts` rather than relied on here.
 */
const BEYOND_STALENESS = EXPIRY + STALENESS + 1n;

const LAM = 15n * WAD;

/** A gap at WAD scale from its decimal spelling, which is how the Python's fixtures read. */
function wadOf(value: string): bigint {
  return Wad.fromStr(value).raw;
}

const PLAUSIBILITY_BAND = wadOf('0.25');

function aPrint(
  gap: string,
  options: { readonly secondsAfterExpiry?: bigint; readonly index?: bigint } = {},
): ReferencePrint {
  return new ReferencePrint({
    source: 'primary',
    priority: 1n,
    timestamp: EXPIRY + (options.secondsAfterExpiry ?? 0n),
    gapWad: wadOf(gap),
    insertionIndex: options.index ?? 0n,
  });
}

interface InputsOptions {
  readonly now?: bigint;
  readonly drifted?: boolean;
  readonly challengeOpen?: boolean;
  readonly fallbackRegistered?: boolean;
}

/**
 * The fields `inputs` builds, exposed so that a case can vary one of them.
 *
 * The Python reached for `dataclasses.replace` to do this. A spread over this object is the same
 * operation, and naming the builder is what makes that possible.
 */
function inputFields(
  prints: readonly ReferencePrint[],
  options: InputsOptions = {},
): RouteInputFields {
  return {
    prints,
    notBefore: EXPIRY,
    now: options.now ?? EXPIRY,
    freshnessBound: FRESHNESS,
    staleBound: STALENESS,
    lamWad: LAM,
    multiplierAtRegistration: new Decimal('1'),
    multiplierNow: new Decimal(options.drifted === true ? '0.98' : '1'),
    plausibilityBandWad: PLAUSIBILITY_BAND,
    challengeOpen: options.challengeOpen ?? false,
    fallbackRegistered: options.fallbackRegistered ?? false,
  };
}

function inputs(prints: readonly ReferencePrint[] = [], options: InputsOptions = {}): RouteInputs {
  return new RouteInputs(inputFields(prints, options));
}

/** A route's declared cost, asserted against its decimal spelling. `undefined` is a valid claim. */
function expectCost(route: SettlementRoute, expected: string | undefined): void {
  const cost = route.expectedCostBp;
  if (expected === undefined) {
    expect(cost).toBeUndefined();
    return;
  }
  expect(cost).toBeDefined();
  expect(cost?.equals(expected)).toBe(true);
}

describe('the route set', () => {
  it('every route is registered', () => {
    expect(new Set(ROUTES.keys())).toEqual(new Set(ROUTE_IDS));
  });

  it('every route reports its own identifier', () => {
    for (const [identifier, route] of ROUTES) {
      expect(route.identifier).toBe(identifier);
    }
  });

  it('the recommended route is the cheapest shipping one', () => {
    // The recommendation has to be the arithmetic outcome, not a preference. If a cheaper route ever
    // ships, this test fails and the recommendation has to be re-argued.
    expect(cheapestShippingRoute()).toBe(RECOMMENDED_ROUTE);
  });

  it('the excluded route is the most expensive', () => {
    const costs: { readonly cost: Decimal; readonly identifier: RouteId }[] = [];
    for (const row of costReport()) {
      if (row.costBp !== undefined) {
        costs.push({ cost: row.costBp, identifier: row.identifier });
      }
    }
    expect(costs.length).toBeGreaterThan(0);

    // Python's `max` over `(cost_bp, identifier)` tuples: the higher cost wins, and a tie goes to the
    // *higher* identifier.
    const worst = costs.reduce((left, right) => {
      if (right.cost.greaterThan(left.cost)) return right;
      if (right.cost.equals(left.cost) && right.identifier > left.identifier) return right;
      return left;
    });

    expect(worst.identifier).toBe(EXCLUDED_ROUTE);
    expect(routeFor(worst.identifier).freeOption).toBe(true);
  });

  it('the cost report orders by identifier and marks the shipper', () => {
    expect(costReport().map((row) => row.identifier)).toEqual([...ROUTE_IDS]);
    expect(
      costReport()
        .filter((row) => row.ships)
        .map((row) => row.identifier),
    ).toEqual([RECOMMENDED_ROUTE]);
  });

  it('the cost report does not quote an unquotable route', () => {
    // R3's cost is a property of a name's calendar, not of the route. A zero would be a claim no name
    // experiences.
    const row = costReport().find((candidate) => candidate.identifier === RouteId.R3);
    expect(row?.costBp).toBeUndefined();
  });

  it('route for refuses an unknown identifier', () => {
    expect(() => routeFor('R9' as RouteId)).toThrow(/R9/);
  });
});

describe.each(ROUTE_IDS)('settling on a print — %s', (identifier) => {
  it('a qualifying print settles the route', () => {
    const outcome = routeFor(identifier).evaluate(inputs([aPrint('0.02')]));
    expect(outcome.action).toBe(SettlementAction.SETTLE_ON_PRINT);
    expect(outcome.payoffWad).toBe(payoffLongWad(LAM, wadOf('0.02')));
    expect(outcome.settles).toBe(true);
  });

  it('a stale print settles on the stale branch', () => {
    const late = EXPIRY + FRESHNESS + 1n;
    const outcome = routeFor(identifier).evaluate(inputs([aPrint('0.02')], { now: late }));
    expect(outcome.branch).toBe(SettlementBranch.STALE_PRINT);
  });

  it('a corporate action routes to the terminal branch', () => {
    // Guard G8 is not a route's choice, so every settling route applies it.
    const outcome = routeFor(identifier).evaluate(inputs([aPrint('-0.02')], { drifted: true }));
    expect(outcome.branch).toBe(SettlementBranch.CORPORATE_ACTION_TERMINAL);
    expect(outcome.payoffWad).toBe(0n);
  });

  it('a negative gap settles as its magnitude', () => {
    // The payoff is even in the gap, so refusing one sign would halve the instrument.
    const positive = routeFor(identifier).evaluate(inputs([aPrint('0.02')]));
    const negative = routeFor(identifier).evaluate(inputs([aPrint('-0.02')]));
    expect(positive.payoffWad).toBe(negative.payoffWad);
  });
});

describe('the fallback branches', () => {
  it('r1 voids at half unconditionally', () => {
    const outcome = routeFor(RouteId.R1).evaluate(inputs());
    expect(outcome.action).toBe(SettlementAction.VOID_AT_HALF);
    expect(outcome.branch).toBe(SettlementBranch.VOID_AT_HALF);
    expect(outcome.payoffWad).toBe(WAD / 2n);
  });

  it('r1 voids at half however large the last gap was', () => {
    // The defect: R1 pays half whatever the gap would have been, so the refund does not depend on the
    // gap at all. This is the free option the paper prices at 29.7 bp.
    const small = routeFor(RouteId.R1).evaluate(
      inputs([aPrint('0.001')], { now: BEYOND_STALENESS }),
    );
    const large = routeFor(RouteId.R1).evaluate(
      inputs([aPrint('0.20')], { now: BEYOND_STALENESS }),
    );
    expect(small.payoffWad).toBe(WAD / 2n);
    expect(large.payoffWad).toBe(WAD / 2n);
  });

  it('r2 defers and pays nothing', () => {
    const outcome = routeFor(RouteId.R2).evaluate(inputs());
    expect(outcome.action).toBe(SettlementAction.DEFER);
    expect(outcome.branch).toBe(SettlementBranch.DEFERRED);
    expect(outcome.payoffWad).toBeUndefined();
    expect(outcome.settles).toBe(false);
  });

  it('r3 voids at half when a drifted reference has no print', () => {
    const outcome = routeFor(RouteId.R3).evaluate(inputs([], { drifted: true }));
    expect(outcome.action).toBe(SettlementAction.VOID_AT_HALF);
    expect(outcome.branch).toBe(SettlementBranch.CORPORATE_ACTION_TERMINAL);
  });

  it('r3 defers when nothing has drifted', () => {
    const outcome = routeFor(RouteId.R3).evaluate(inputs());
    expect(outcome.action).toBe(SettlementAction.DEFER);
  });

  it('r4 refunds when the feed merely stopped', () => {
    // A plausible last print is consistent with the feed having stopped, so the refund is paid.
    const outcome = routeFor(RouteId.R4).evaluate(
      inputs([aPrint('0.01')], { now: BEYOND_STALENESS }),
    );
    expect(outcome.action).toBe(SettlementAction.CONSTANT_REFUND);
    expect(outcome.payoffWad).toBe(WAD / 2n);
  });

  it('r4 defers when the last print is implausible', () => {
    // An implausible last print is a market event rather than a feed outage, and paying half on a
    // market event is exactly the free option R4 exists to reduce.
    const outcome = routeFor(RouteId.R4).evaluate(
      inputs([aPrint('0.40')], { now: BEYOND_STALENESS }),
    );
    expect(outcome.action).toBe(SettlementAction.DEFER);
    expect(outcome.payoffWad).toBeUndefined();
  });

  it('r4 defers when nothing has ever been printed', () => {
    const outcome = routeFor(RouteId.R4).evaluate(inputs());
    expect(outcome.action).toBe(SettlementAction.DEFER);
  });

  it('r5 defers and names the challenge state', () => {
    const plain = routeFor(RouteId.R5).evaluate(inputs());
    const challenged = routeFor(RouteId.R5).evaluate(inputs([], { challengeOpen: true }));
    expect(plain.action).toBe(SettlementAction.DEFER);
    expect(challenged.action).toBe(SettlementAction.DEFER);
    expect(plain.payoffWad).toBeUndefined();
    expect(challenged.payoffWad).toBeUndefined();
    expect(challenged.rationale).toContain('challenge');
    expect(plain.rationale).not.toContain('challenge');
  });

  it('r5 distinguishes a challenged commitment with a fallback', () => {
    // The third state: challenged *and* a trailing-realised fallback registered. R5's rationale has
    // three cases and the test above reaches two of them — no challenge, and a challenge with no
    // fallback. The middle one is the state the fallback mechanism exists to produce: the commitment
    // is under dispute, so the pool cannot price on it, but a registered fallback means it can price
    // on something rather than halting. All three defer, so the payoff cannot tell them apart; the
    // rationale is the only thing that can, so it is what is asserted.
    const withFallback = routeFor(RouteId.R5).evaluate(
      inputs([], { challengeOpen: true, fallbackRegistered: true }),
    );
    const withoutFallback = routeFor(RouteId.R5).evaluate(inputs([], { challengeOpen: true }));

    expect(withFallback.action).toBe(SettlementAction.DEFER);
    expect(withFallback.payoffWad).toBeUndefined();
    expect(withFallback.rationale).toContain('fallback');
    expect(withFallback.rationale).not.toBe(withoutFallback.rationale);
  });

  it('the adjusted gap refuses a zero multiplier', () => {
    // The ex-date adjustment divides by the current multiplier, so a zero leaves it undefined.
    //
    // `RouteInputs` does not refuse a zero at construction: a route that never asks for the adjusted
    // gap should not be made to care, and the four routes that do not are the majority. The refusal
    // belongs where the division is.
    const zeroed = new RouteInputs({
      ...inputFields([], { drifted: true }),
      multiplierNow: new Decimal(0),
    });
    expect(() => zeroed.adjustedGapWad(WAD)).toThrow(/zero multiplier/);
  });
});

describe('route declarations', () => {
  it('the published costs are reproduced', () => {
    expectCost(routeFor(RouteId.R1), '29.7');
    expectCost(routeFor(RouteId.R2), '0.021');
    expectCost(routeFor(RouteId.R3), undefined);
    expectCost(routeFor(RouteId.R4), '1.37');
    expectCost(routeFor(RouteId.R5), '1.37');
  });

  it('only the void routes carry a free option', () => {
    expect(routeFor(RouteId.R1).freeOption).toBe(true);
    expect(routeFor(RouteId.R4).freeOption).toBe(true);
    expect(routeFor(RouteId.R2).freeOption).toBe(false);
    expect(routeFor(RouteId.R3).freeOption).toBe(false);
    expect(routeFor(RouteId.R5).freeOption).toBe(false);
  });

  it('the non-monotone routes are the refunding ones', () => {
    // A refund that does not depend on the gap is not monotone in the gap, which is what admits a
    // strategy that extracts value from settlement rather than from the gap.
    expect(routeFor(RouteId.R1).monotone).toBe(false);
    expect(routeFor(RouteId.R4).monotone).toBe(false);
    expect(routeFor(RouteId.R2).monotone).toBe(true);
    expect(routeFor(RouteId.R3).monotone).toBe(true);
    expect(routeFor(RouteId.R5).monotone).toBe(true);
  });
});

describe('the payoff primitive', () => {
  it('the payoff is capped at the collateral unit', () => {
    expect(payoffLongWad(LAM, WAD)).toBe(WAD);
    expect(payoffLongWad(LAM, 10n * WAD)).toBe(WAD);
  });

  it('the payoff is linear below the cap', () => {
    expect(payoffLongWad(LAM, wadOf('0.02'))).toBe(wadOf('0.30'));
  });

  it('the payoff saturates at the reciprocal of the leverage', () => {
    // `|G| >= 1/lambda` is exactly where the cap binds, which is the property the leverage rule is
    // built on.
    //
    // `ceil(1/lambda)`, not `floor(1/lambda)`: the floor sits one wei below the true crossing, where
    // the payoff is still short of the cap. The same one-wei boundary DESIGN_NOTES.md F13 records for
    // the contract's `saturationGapWad`.
    const threshold = (WAD * WAD + LAM - 1n) / LAM;
    expect(payoffLongWad(LAM, threshold - 1n)).toBeLessThan(WAD);
    expect(payoffLongWad(LAM, threshold)).toBe(WAD);
  });

  it('the payoff is even', () => {
    expect(payoffLongWad(LAM, 12_345n)).toBe(payoffLongWad(LAM, -12_345n));
  });
});
