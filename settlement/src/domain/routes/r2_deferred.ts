/**
 * R2: deferred settlement on the first valid print.
 *
 * The recommended architecture. When no print qualifies, nothing is settled: the session stays
 * `Expired` and the first qualifying print settles it whenever it arrives.
 *
 * The cost is 0.021 bp per session, and the free option is removed **exactly** rather than reduced —
 * not because the deferral is cheap, but because it is not an option at all. A deferral fixes no
 * payoff, so there is no state of the world in which a holder receives a payment that was not earned.
 * R1's 29.7 bp is the price of a payment on an absent print; R2's 0.021 bp is the price of waiting.
 *
 * The one cost that is real: a deferred session cannot be claimed against, so capital stays locked for
 * as long as the feed is down. That is a liveness cost rather than an economic one, and it is bounded
 * by the fact that a feed which never returns is a terminal event the paper's §12.2 treats separately.
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

export class DeferredSettlementRoute implements SettlementRoute {
  readonly identifier: RouteId = RouteId.R2;

  /** 0.021 bp per session, measured. */
  readonly expectedCostBp: Decimal = new Decimal('0.021');

  /** Monotone: the payoff is the payoff function, evaluated later. */
  readonly monotone: boolean = true;

  /** None at all. A deferral pays nothing, so there is nothing to extract. */
  readonly freeOption: boolean = false;

  evaluate(inputs: RouteInputs): RouteOutcome {
    const selection = inputs.select();
    if (selection.kind === 'selected') {
      return settleOnPrint(inputs, selection, {
        route: this.identifier,
        costBp: this.expectedCostBp,
      });
    }
    return new RouteOutcome({
      route: this.identifier,
      action: SettlementAction.DEFER,
      branch: SettlementBranch.DEFERRED,
      payoffWad: undefined,
      selected: undefined,
      costBp: this.expectedCostBp,
      rationale: 'no print qualified; the session stays expired until one does',
    });
  }
}
