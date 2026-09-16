/**
 * R4: constant refund with a plausibility band.
 *
 * Refund both legs at half, but only when the most recent print looks like a *feed outage* rather
 * than a market event: the refund is paid when the latest gap is inside the plausibility band, and the
 * route defers when it is outside.
 *
 * That conditionality is the whole difference between R4 and R1, and it is what makes R4's free
 * option *reduced* rather than absent. R1 pays half whatever the gap would have been, so a holder
 * receives a windfall on every settlement failure; R4 pays half only when the failure is consistent
 * with the feed having stopped, so a large move — the case a hedger actually bought the instrument for
 * — is not refunded at a fixed price. The paper measures the defect at 1.37 bp against R1's 29.7 bp.
 *
 * **An interpretation, stated.** The paper describes R4 as "constant refund with a plausibility band"
 * and gives its cost, without defining the band or the constant. The reading implemented here is the
 * one that reproduces the *shape* the paper reports — a reduced rather than absent free option, at a
 * cost between R2's and R1's — and it is recorded as F37 in DESIGN_NOTES.md. The constant is half,
 * matching R1, because a refund at any other value would make R4 a different instrument rather than a
 * conditional version of the same one.
 */

import { WAD } from '@bell/calibrator/domain/constants.js';
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

export class PlausibilityRefundRoute implements SettlementRoute {
  readonly identifier: RouteId = RouteId.R4;

  /** 1.37 bp per session, measured. */
  readonly expectedCostBp: Decimal = new Decimal('1.37');

  /** Not monotone: the refund does not depend on the settled gap. */
  readonly monotone: boolean = false;

  /** Reduced rather than absent. Present, so the answer is yes. */
  readonly freeOption: boolean = true;

  evaluate(inputs: RouteInputs): RouteOutcome {
    const selection = inputs.select();
    if (selection.kind === 'selected') {
      return settleOnPrint(inputs, selection, {
        route: this.identifier,
        costBp: this.expectedCostBp,
      });
    }

    const latestGap = inputs.mostRecentGapWad();
    const magnitude = latestGap === undefined || latestGap >= 0n ? latestGap : -latestGap;
    const plausible = magnitude !== undefined && magnitude <= inputs.plausibilityBandWad;
    if (!plausible) {
      return new RouteOutcome({
        route: this.identifier,
        action: SettlementAction.DEFER,
        branch: SettlementBranch.DEFERRED,
        payoffWad: undefined,
        selected: undefined,
        costBp: this.expectedCostBp,
        rationale:
          'no print qualified and the latest one is outside the plausibility band, which ' +
          'is a market event rather than a feed outage; the refund is not paid',
      });
    }
    return new RouteOutcome({
      route: this.identifier,
      action: SettlementAction.CONSTANT_REFUND,
      branch: SettlementBranch.VOID_AT_HALF,
      payoffWad: WAD / 2n,
      selected: undefined,
      costBp: this.expectedCostBp,
      rationale: 'no print qualified but the feed looks merely stopped, so the refund is paid',
    });
  }
}
