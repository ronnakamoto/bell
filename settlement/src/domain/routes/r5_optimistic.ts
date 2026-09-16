/**
 * R5: the optimistic challenge window.
 *
 * Settlement is optimistic — the first valid print settles it — and the *parameter set* the pool
 * priced against can be challenged within a window afterwards. The 1.37 bp per session is the cost of
 * that window, and the paper's §7.11 puts the mechanism itself in `PremiumRegistry`: a commitment made
 * before the session opens, a bond on each side, and a deterministic re-run of the committed inputs.
 *
 * **A finding, stated.** The brief's §4.3 presents R5 as one of five *settlement routes*, but its
 * settlement rule is R2's. What distinguishes it is a dispute mechanism over the parameter set, which
 * is not a settlement rule at all — it changes what the pool prices against, not how a session
 * resolves. This route therefore settles exactly as R2 does and reports the challenge state in its
 * rationale, rather than inventing a settlement behaviour the paper does not describe. Recorded as F38
 * in DESIGN_NOTES.md.
 *
 * The consequence is worth naming: R5 and R2 are not alternatives. R2 is a settlement route and R5 is
 * that route plus a pricing-trust mechanism, so a venue choosing between them is choosing whether to
 * police the parameter set, not how to settle.
 */

import { Decimal } from 'decimal.js';

import {
  RouteId,
  type RouteInputs,
  RouteOutcome,
  SettlementAction,
  SettlementBranch,
  type SettlementRoute,
} from './base.js';
import { settleOnPrint } from './settle.js';

export class OptimisticChallengeRoute implements SettlementRoute {
  readonly identifier: RouteId = RouteId.R5;

  /** 1.37 bp per session, measured, and already carried in the settlement budget. */
  readonly expectedCostBp: Decimal = new Decimal('1.37');

  /** Monotone: the settlement rule is R2's. */
  readonly monotone: boolean = true;

  /** None at settlement. A challenged *parameter* is a pricing question, not a payoff. */
  readonly freeOption: boolean = false;

  evaluate(inputs: RouteInputs): RouteOutcome {
    const selection = inputs.select();
    if (selection.kind === 'selected') {
      return settleOnPrint(inputs, selection, {
        route: this.identifier,
        costBp: this.expectedCostBp,
      });
    }

    // No print. Whether a challenge is open changes nothing about settlement: a deferral pays
    // nothing in either case, which is what makes the free option absent rather than reduced.
    let rationale: string;
    if (inputs.challengeOpen && !inputs.fallbackRegistered) {
      rationale =
        'no print qualified, and the commitment is challenged with no fallback registered, ' +
        'so the pool has nothing to price on; the session stays expired';
    } else if (inputs.challengeOpen) {
      rationale =
        'no print qualified while a challenge is open; the pool prices on the registered ' +
        'fallback and the session stays expired';
    } else {
      rationale = 'no print qualified; the session stays expired until one does';
    }

    return new RouteOutcome({
      route: this.identifier,
      action: SettlementAction.DEFER,
      branch: SettlementBranch.DEFERRED,
      payoffWad: undefined,
      selected: undefined,
      costBp: this.expectedCostBp,
      rationale,
    });
  }
}
