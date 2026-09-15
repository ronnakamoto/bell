/**
 * The settlement route interface, and the types every route shares.
 *
 * Five routes, one protocol. The route is a **Strategy** rather than a branch inside one function
 * because the set is open: the brief's §5.2 names settlement routes as an open set that must be
 * selectable and comparable at runtime, and the paper's §8.4 compares all five on cost. A single
 * `if`-chain would make adding a route a change to the settlement path, which is the last place a
 * change should be.
 *
 * Each route declares three things beyond its behaviour, and all three are load-bearing for the
 * comparison the paper makes:
 *
 * - `expectedCostBp`, so the choice of route is a stated number rather than a preference.
 * - `monotone`, because a non-monotone payoff admits a strategy that extracts value from settlement
 *   rather than from the gap.
 * - `freeOption`, because a route that pays on an absent print writes an option to its own hedgers at
 *   no premium. That is the defect R1 has and R2 removes.
 *
 * **A time is a `bigint` count of Unix seconds**, for the reasons `prints.ts` states at length — the
 * contract's representation is the one that has to agree, and `Date` is a double in a costume that
 * the domain may not reach for. The Python's `datetime`/`timedelta` pair becomes `bigint` here.
 *
 * **The arithmetic is pinned to CPython's default `decimal` context, and leaving it at
 * `decimal.js`'s default is a measured error that reaches the payoff.** `decimal.js` computes at 20
 * significant digits; CPython's `decimal` default context is 28. `adjustedGapWad` divides a 19-digit
 * gross return by the multiplier ratio and then *truncates*, and at 20 significant digits a 19-digit
 * integer quotient has only one fractional digit left — so a true value whose fraction sits at or
 * above 0.95 rounds up to the next integer and truncates to one wei too many.
 *
 * Measured rather than argued, and measured on an *ordinary* input rather than a contrived one: for
 * `gapWad = -0.02 * WAD` and `multiplierNow = 1.000318` — a 0.03% drift, which is what a small
 * distribution looks like — the oracle's adjusted gap is `-20311540929984266` and the unpinned port's
 * is `-20311540929984265`. That one wei becomes **15 wei of payoff** once `payoffLongWad` multiplies
 * it by `lambda = 15`: `304673113949763990` against `304673113949763975`.
 *
 * A larger drift hides the difference rather than exposing it, which is why the example above is the
 * small one. At `multiplierNow = 0.100052`, a 10:1 reverse split, the two truncations do differ —
 * `9794906648542757765` against `9794906648542757766` — but the adjusted gap is far past the
 * saturation point, so both payoffs are capped at `WAD` and the divergence is invisible.
 *
 * The clone is named `D28` rather than `D` deliberately: `moments.ts` exports a `D` at **50** digits
 * for the transcendental work, and two modules carrying two different precisions under one name is
 * how a reader concludes they are the same. The name states the number that matters.
 *
 * `Decimal.clone` rather than `Decimal.set`, for the reason `moments.ts` gives: a clone is a separate
 * constructor carrying its own precision, so this module's 28 digits cannot leak into another
 * module's arithmetic and no other module can silently lower them. `Decimal.set` would be a mutable
 * global, which the domain may not have.
 */

import { Decimal } from 'decimal.js';

import { WAD } from '@bell/calibrator/domain/constants.js';
import { DomainError } from '@bell/calibrator/domain/models.js';

import {
  type PrintSelected,
  type ReferencePrint,
  type SelectionResult,
  selectPrint,
} from '../prints.js';

// ---------------------------------------------------------------- the vocabulary

/** The five routes of the paper's §8.4, in the order it compares them. */
export const RouteId = {
  R1: 'R1',
  R2: 'R2',
  R3: 'R3',
  R4: 'R4',
  R5: 'R5',
} as const;

export type RouteId = (typeof RouteId)[keyof typeof RouteId];

/**
 * Every route identifier, ordered.
 *
 * Sorted rather than left in declaration order, because the cost report's order is *"the order the
 * paper compares them in"* and the Python sorted it explicitly. The two coincide for `R1`…`R5`, and
 * that coincidence is exactly why the sort has to be written down: a sixth route named `R10` would
 * break declaration order and nothing would say so.
 */
export const ROUTE_IDS: readonly RouteId[] = Object.values(RouteId).toSorted();

/**
 * What a route decides to do.
 *
 * Four actions rather than two, because "void at half" and "constant refund" are different economic
 * objects even though both pay a constant: the first pays unconditionally and the second pays only
 * inside a plausibility band, which is exactly why the second has a smaller free option.
 */
export const SettlementAction = {
  SETTLE_ON_PRINT: 'settle_on_print',
  VOID_AT_HALF: 'void_at_half',
  CONSTANT_REFUND: 'constant_refund',
  DEFER: 'defer',
} as const;

export type SettlementAction = (typeof SettlementAction)[keyof typeof SettlementAction];

/**
 * The branch recorded on the settlement. Mirrors the contract's `Branch` enum.
 *
 * The five values are the snake_case of `contracts/src/types/Branch.sol`'s members, so a reader can
 * map one to the other without a table.
 */
export const SettlementBranch = {
  LIVE_PRINT: 'live_print',
  STALE_PRINT: 'stale_print',
  CORPORATE_ACTION_TERMINAL: 'corporate_action_terminal',
  VOID_AT_HALF: 'void_at_half',
  DEFERRED: 'deferred',
} as const;

export type SettlementBranch = (typeof SettlementBranch)[keyof typeof SettlementBranch];

/** CPython's default `decimal` context precision, which is what the oracle computes in. */
const ORACLE_PRECISION = 28;

/** The arithmetic this module computes in. See the header for why it is 28 and not 20 or 50. */
const D28 = Decimal.clone({ precision: ORACLE_PRECISION });

// ---------------------------------------------------------------- the inputs

/** The fields of `RouteInputs`, named at the call site. */
export interface RouteInputFields {
  readonly prints: readonly ReferencePrint[];
  readonly notBefore: bigint;
  readonly now: bigint;
  readonly freshnessBound: bigint;
  readonly staleBound: bigint;
  readonly lamWad: bigint;
  readonly multiplierAtRegistration: Decimal;
  readonly multiplierNow: Decimal;
  readonly plausibilityBandWad: bigint;
  /** Whether a challenge to the committed parameter set is open. Read only by route R5. */
  readonly challengeOpen?: boolean;
  /** Whether a trailing-realised fallback is registered. Read only by route R5. */
  readonly fallbackRegistered?: boolean;
}

/**
 * Everything a route may consult. Passed whole rather than as six parameters.
 *
 * The multiplier is carried as a pair rather than as a boolean so that a route can compute the
 * *adjusted* gap rather than merely detect that one is needed — a route that knew only "drifted"
 * would have to guess at the adjustment.
 *
 * The last two fields default to the "nothing disputed" case, which is what lets the other four
 * routes not know about them at all.
 */
export class RouteInputs {
  readonly prints: readonly ReferencePrint[];
  readonly notBefore: bigint;
  readonly now: bigint;
  readonly freshnessBound: bigint;
  readonly staleBound: bigint;
  readonly lamWad: bigint;
  readonly multiplierAtRegistration: Decimal;
  readonly multiplierNow: Decimal;
  readonly plausibilityBandWad: bigint;
  readonly challengeOpen: boolean;
  readonly fallbackRegistered: boolean;

  constructor(fields: RouteInputFields) {
    this.prints = fields.prints;
    this.notBefore = fields.notBefore;
    this.now = fields.now;
    this.freshnessBound = fields.freshnessBound;
    this.staleBound = fields.staleBound;
    this.lamWad = fields.lamWad;
    this.multiplierAtRegistration = fields.multiplierAtRegistration;
    this.multiplierNow = fields.multiplierNow;
    this.plausibilityBandWad = fields.plausibilityBandWad;
    this.challengeOpen = fields.challengeOpen ?? false;
    this.fallbackRegistered = fields.fallbackRegistered ?? false;
  }

  /**
   * Whether the reference token's multiplier moved between registration and settlement.
   *
   * A difference of any size counts. The multiplier is an exact quantity rather than a measurement:
   * a split or an ex-date moves it by a stated ratio, so a difference of one wei is a corporate
   * action rather than noise.
   */
  get multiplierDrifted(): boolean {
    return !this.multiplierNow.equals(this.multiplierAtRegistration);
  }

  /** The settlement print, or a report that none qualifies. */
  select(): SelectionResult {
    return selectPrint(this.prints, {
      notBefore: this.notBefore,
      now: this.now,
      freshnessBound: this.freshnessBound,
      staleBound: this.staleBound,
    });
  }

  /**
   * The gap of the latest print, whether or not it qualifies.
   *
   * Used by route R4, which has to distinguish a feed outage from a market event before it refunds:
   * a plausible gap suggests the feed stopped, and an implausible one suggests the market moved.
   * `undefined` when nothing has ever been printed.
   *
   * **Priority is deliberately not consulted**, and this is the one place in the module where the
   * ordering is not `bestPrint`'s. The question R4 asks is what the feed *last said*, not which
   * source the book would prefer, so the rule is the latest timestamp and then the lowest insertion
   * index among the prints carrying it.
   */
  mostRecentGapWad(): bigint | undefined {
    let latestTimestamp: bigint | undefined;
    for (const candidate of this.prints) {
      if (latestTimestamp === undefined || candidate.timestamp > latestTimestamp) {
        latestTimestamp = candidate.timestamp;
      }
    }
    if (latestTimestamp === undefined) {
      return undefined;
    }

    let winner: ReferencePrint | undefined;
    for (const candidate of this.prints) {
      if (candidate.timestamp !== latestTimestamp) {
        continue;
      }
      if (winner === undefined || candidate.insertionIndex < winner.insertionIndex) {
        winner = candidate;
      }
    }
    return winner?.gapWad;
  }

  /**
   * The ex-date adjustment: `(1 + G) * m_registration / m_now - 1`.
   *
   * On an ex-date the headline return is not a market move: it contains the distribution, and the
   * multiplier moves by the same factor, so dividing the gross return by the multiplier's movement
   * removes the distribution and leaves the market gap. Paying on the headline would record a
   * spurious gap on every ex-date and route it through the live branch, which is what guard G8
   * exists to prevent.
   *
   * **The truncation is `int()`'s, not a rounding.** Python's `int(Decimal)` truncates toward zero,
   * so the port asks for `ROUND_DOWN` explicitly — `decimal.js`'s `toFixed` defaults to
   * `ROUND_HALF_UP`, which would be a different rule on every negative adjusted gap, i.e. on half of
   * them.
   */
  adjustedGapWad(gapWad: bigint): bigint {
    if (this.multiplierNow.isZero()) {
      throw new DomainError('a zero multiplier makes the adjusted gap undefined');
    }
    const gross = new D28((WAD + gapWad).toString());
    const adjusted = gross.times(this.multiplierAtRegistration).dividedBy(this.multiplierNow);
    return BigInt(adjusted.toFixed(0, D28.ROUND_DOWN)) - WAD;
  }
}

// ---------------------------------------------------------------- the outcome

/** The fields of `RouteOutcome`, named at the call site because four of the seven are union-typed. */
export interface RouteOutcomeFields {
  readonly route: RouteId;
  readonly action: SettlementAction;
  readonly branch: SettlementBranch;
  readonly payoffWad: bigint | undefined;
  readonly selected: ReferencePrint | undefined;
  readonly costBp: Decimal;
  readonly rationale: string;
}

/**
 * What a route decided, and why.
 *
 * `payoffWad` is `undefined` exactly when the action is a deferral, and the type says so rather than
 * the caller having to know. A deferral is the absence of a decision, not a decision that the payoff
 * is zero: settling a deferred session on a zero would mint a free claim, which is the fail-open the
 * brief forbids in as many words.
 *
 * `payoffWad` is a required field that may hold `undefined`, rather than an optional field. The
 * Python's dataclass has no default, so every construction site states it; `payoffWad?: bigint` under
 * `exactOptionalPropertyTypes` would let a site omit it, which reads like "zero" at a glance and is
 * the one reading that must not be available here.
 */
export class RouteOutcome {
  readonly route: RouteId;
  readonly action: SettlementAction;
  readonly branch: SettlementBranch;
  readonly payoffWad: bigint | undefined;
  readonly selected: ReferencePrint | undefined;
  readonly costBp: Decimal;
  readonly rationale: string;

  constructor(fields: RouteOutcomeFields) {
    this.route = fields.route;
    this.action = fields.action;
    this.branch = fields.branch;
    this.payoffWad = fields.payoffWad;
    this.selected = fields.selected;
    this.costBp = fields.costBp;
    this.rationale = fields.rationale;
  }

  /** Whether this outcome fixes a payoff. */
  get settles(): boolean {
    return this.payoffWad !== undefined;
  }
}

/**
 * One settlement route.
 *
 * An interface rather than an abstract base class, so a route is any object with these members and
 * an adapter can supply one without importing the domain. Python needed `Protocol` for the same
 * reason; TypeScript gets it structurally and for free.
 */
export interface SettlementRoute {
  /** Which route this is. */
  readonly identifier: RouteId;

  /**
   * The expected cost in basis points of notional per session.
   *
   * `undefined` means the route cannot be priced from the aggregate. R3's cost depends on a name's
   * corporate-action calendar rather than on the route, so a single number would be a claim no name
   * experiences — and the report says so rather than quoting an average.
   */
  readonly expectedCostBp: Decimal | undefined;

  /** Whether the payoff is monotone in the absolute gap. */
  readonly monotone: boolean;

  /** Whether the route pays on an absent print, writing an option at no premium. */
  readonly freeOption: boolean;

  /** Evaluate the route against a set of inputs. */
  evaluate(inputs: RouteInputs): RouteOutcome;
}

// ---------------------------------------------------------------- the shared settling path

/**
 * `min(lambda * |G|, 1)`, the long claim's terminal payoff at WAD scale.
 *
 * Mirrors `contracts/src/libraries/Payoff.sol`. A second implementation is a divergence risk, so the
 * two are held together by the differential suite rather than by convention — and this one is the
 * reference the contract is checked against.
 *
 * The division is `bigint`'s, which truncates toward zero. Every numerator here is a product of two
 * non-negative values, so truncation and floor agree and no `floorDiv` is needed; the guard is that
 * statement, not a hope.
 */
export function payoffLongWad(lamWad: bigint, gapWad: bigint): bigint {
  const magnitude = gapWad < 0n ? -gapWad : gapWad;
  const scaled = (lamWad * magnitude) / WAD;
  return scaled < WAD ? scaled : WAD;
}

/** The two things a route contributes to the shared settling path. */
export interface SettleOnPrintOptions {
  readonly route: RouteId;
  readonly costBp: Decimal;
}

/**
 * The shared settling path: adjust for a corporate action, then price the gap.
 *
 * Every route that settles on a print goes through here, since the multiplier adjustment is guard G8
 * and is not a route's choice. What a route *does* choose is what happens when no print qualifies,
 * which is where the five differ and where the cost comparison lives.
 *
 * The branch names the corporate action when the multiplier moved, so the settlement record says
 * which of the two very different things happened rather than leaving it to be inferred from the
 * payoff.
 *
 * `route` and `costBp` arrive as one object rather than as two more parameters. The Python made them
 * keyword-only for the reason `selectPrint`'s bounds are an object here: both are positional
 * neighbours of a `RouteInputs`, and a swap would compile.
 */
export function settleOnPrint(
  inputs: RouteInputs,
  selection: PrintSelected,
  options: SettleOnPrintOptions,
): RouteOutcome {
  const drift = inputs.multiplierDrifted;
  const gapWad = drift ? inputs.adjustedGapWad(selection.print.gapWad) : selection.print.gapWad;

  let branch: SettlementBranch;
  if (drift) {
    branch = SettlementBranch.CORPORATE_ACTION_TERMINAL;
  } else if (selection.isStale) {
    branch = SettlementBranch.STALE_PRINT;
  } else {
    branch = SettlementBranch.LIVE_PRINT;
  }

  return new RouteOutcome({
    route: options.route,
    action: SettlementAction.SETTLE_ON_PRINT,
    branch,
    payoffWad: payoffLongWad(inputs.lamWad, gapWad),
    selected: selection.print,
    costBp: options.costBp,
    rationale: 'a print qualified, so the fallback was not reached',
  });
}
