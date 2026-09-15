/**
 * R1: void at half.
 *
 * The intuitive fallback. When no print qualifies, both legs are refunded at half value.
 *
 * **It must never ship.** Paying half on an absent print writes a free long butterfly struck at `c/2`
 * to the protocol's own hedgers: a long holder receives half whenever the settlement feed fails,
 * whatever the gap would have been. The paper measures the defect at 29.7 basis points of notional per
 * session, or 14.3% of the premium paid. Route R2 removes it *exactly*, at a cost of 0.021 bp — a
 * factor of about 1,400 between the defect and the fix, which is why the paper excludes R1 by test
 * rather than by preference.
 *
 * The route is implemented rather than omitted because the comparison has to be reproducible. A
 * rejected alternative that no longer exists cannot be re-measured.
 */

import { Decimal } from 'decimal.js';

import { WAD } from '@bell/calibrator/domain/constants.js';

import {
  RouteId,
  type RouteInputs,
  RouteOutcome,
  type SettlementRoute,
  SettlementAction,
  SettlementBranch,
} from './base.js';
import { settleOnPrint } from './settle.js';

export class VoidAtHalfRoute implements SettlementRoute {
  readonly identifier: RouteId = RouteId.R1;

  /** 29.7 bp per session, measured. */
  readonly expectedCostBp: Decimal = new Decimal('29.7');

  /** Not monotone: the refund does not depend on the gap at all. */
  readonly monotone: boolean = false;

  /** Yes, and that is the whole objection to it. */
  readonly freeOption: boolean = true;

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
      action: SettlementAction.VOID_AT_HALF,
      branch: SettlementBranch.VOID_AT_HALF,
      payoffWad: WAD / 2n,
      selected: undefined,
      costBp: this.expectedCostBp,
      rationale: 'no print qualified, so both legs are refunded at half',
    });
  }
}
