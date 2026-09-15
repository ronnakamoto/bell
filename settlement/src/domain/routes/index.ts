/**
 * The route registry, and the cost report.
 *
 * Five routes behind one interface, selectable and comparable at runtime. The registry is a plain
 * mapping rather than a factory: a route is stateless, so constructing one per call buys nothing, and
 * a mapping makes the set enumerable — which is what "the others must remain selectable so the
 * comparison is reproducible" actually requires.
 *
 * The cost report is the brief's §4.3 item 4: *"Report the cost of each route, in basis points per
 * session, so the choice of route is a stated number rather than a preference."* It reports R3 as
 * unquotable rather than as zero, because a number no name experiences is worse than an absent one.
 */

import { type Decimal } from 'decimal.js';

import { DomainError } from '@bell/calibrator/domain/models.js';

import { ROUTE_IDS, RouteId, type SettlementRoute } from './base.js';
import { VoidAtHalfRoute } from './r1_void.js';
import { DeferredSettlementRoute } from './r2_deferred.js';
import { CorporateActionTerminalRoute } from './r3_terminal.js';
import { PlausibilityRefundRoute } from './r4_multi_source_void.js';
import { OptimisticChallengeRoute } from './r5_optimistic.js';

/** Every route, by identifier. Built once at module load, because a route holds no state. */
export const ROUTES: ReadonlyMap<RouteId, SettlementRoute> = new Map<RouteId, SettlementRoute>([
  [RouteId.R1, new VoidAtHalfRoute()],
  [RouteId.R2, new DeferredSettlementRoute()],
  [RouteId.R3, new CorporateActionTerminalRoute()],
  [RouteId.R4, new PlausibilityRefundRoute()],
  [RouteId.R5, new OptimisticChallengeRoute()],
]);

/**
 * The route the paper recommends, and the one that ships.
 *
 * Named rather than written as a literal at each call site, so that "which route is the default" is
 * answerable in one place.
 */
export const RECOMMENDED_ROUTE: RouteId = RouteId.R2;

/** The route the paper excludes by test rather than by preference. */
export const EXCLUDED_ROUTE: RouteId = RouteId.R1;

/**
 * The route with this identifier.
 *
 * **It throws rather than returning `undefined`, and the difference is deliberate.** A `Map.get` that
 * a caller forgets to check is a settlement route chosen by absence, which is the fail-open the brief
 * forbids — and the type system cannot rule it out here, because an identifier that arrived from a
 * configuration file or a request is a `string` wearing a `RouteId`'s name. The Python raised
 * `KeyError`; the port raises `DomainError`, which is the one error type the domain throws, so a
 * caller catches one thing.
 */
export function routeFor(identifier: RouteId): SettlementRoute {
  const route = ROUTES.get(identifier);
  if (route === undefined) {
    throw new DomainError(`no settlement route is registered as ${identifier}`);
  }
  return route;
}

/** One row of the cost report. */
export interface RouteCost {
  readonly identifier: RouteId;
  readonly costBp: Decimal | undefined;
  readonly monotone: boolean;
  readonly freeOption: boolean;
  readonly ships: boolean;
}

/**
 * The cost of every route, in basis points of notional per session.
 *
 * `costBp` is `undefined` for a route whose cost is name-specific, which is R3. The report is a
 * `readonly` array rather than a map so that it has an order — the order the paper compares them in —
 * and so that it cannot be mutated by a caller that wants a different ranking.
 */
export function costReport(): readonly RouteCost[] {
  return ROUTE_IDS.map((identifier) => {
    const route = routeFor(identifier);
    return {
      identifier,
      costBp: route.expectedCostBp,
      monotone: route.monotone,
      freeOption: route.freeOption,
      ships: identifier === RECOMMENDED_ROUTE,
    };
  });
}

/**
 * The cheapest route that ships, which is the one the design should select.
 *
 * Throws rather than returning a default when nothing ships, because a default here would be a
 * settlement route chosen by absence.
 */
export function cheapestShippingRoute(): RouteId {
  const quotable: { readonly cost: Decimal; readonly identifier: RouteId }[] = [];
  for (const row of costReport()) {
    if (row.ships && row.costBp !== undefined) {
      quotable.push({ cost: row.costBp, identifier: row.identifier });
    }
  }
  if (quotable.length === 0) {
    throw new DomainError('no shipping route has a quotable cost');
  }

  // `min` over the pairs, with Python's tuple comparison spelled out: the lower cost wins, and a tie
  // goes to the *lower* identifier. The tie is unreachable while `ships` marks exactly one route —
  // written out anyway, because a tie-break that exists only in the oracle is a divergence waiting
  // for the day `ships` becomes a set.
  const best = quotable.reduce((left, right) => {
    if (right.cost.lessThan(left.cost)) {
      return right;
    }
    if (right.cost.equals(left.cost) && right.identifier < left.identifier) {
      return right;
    }
    return left;
  });

  return best.identifier;
}
