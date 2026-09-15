/**
 * R3: the corporate-action-adjusted terminal branch.
 *
 * When the reference token's multiplier has moved between registration and settlement, the headline
 * return is not a market move. This route settles on the *adjusted* gap and records the terminal
 * corporate-action branch, so an ex-date changes the branch rather than printing a gap.
 *
 * **An interpretation, stated.** The paper's §8.4 gives R3's cost as name-specific and describes it as
 * the corporate-action-adjusted terminal branch, without specifying what it does when no print
 * qualifies. The reading implemented here is that a drifted reference has no future print to defer to
 * — the corporate action is the terminal event, and the feed's behaviour after it is not something
 * settlement can wait on — so the route voids at half when the multiplier has drifted and defers when
 * it has not. Recorded as F37 in DESIGN_NOTES.md.
 *
 * The cost is therefore not a single number. A route whose cost depends on a name's corporate-action
 * calendar cannot be priced from the aggregate, and the honest report says so rather than quoting an
 * average that no name experiences.
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

export class CorporateActionTerminalRoute implements SettlementRoute {
  readonly identifier: RouteId = RouteId.R3;

  /**
   * Not quotable as a single number, and the type says so.
   *
   * The cost is the probability that a print fails to arrive between a corporate action and the next
   * settlement, which is a property of the name's calendar rather than of the route. A zero here
   * would be a claim the route cannot make; `costReport` reports it as unquotable and the caller has
   * to say which name it means.
   */
  readonly expectedCostBp: Decimal | undefined = undefined;

  /** Monotone: the adjusted gap is still a gap. */
  readonly monotone: boolean = true;

  /** None. The void branch is reachable only when the reference has terminated. */
  readonly freeOption: boolean = false;

  /**
   * R3's own cost, which is not a number.
   *
   * Every outcome it produces carries `Decimal(0)` rather than `expectedCostBp`, because the cost of
   * a *particular* settlement is not the unquotable calendar probability — a settlement that
   * happened cost nothing extra. The Python did the same, and the distinction is why this field is
   * `undefined` while the outcomes are zero.
   */
  private static readonly CHARGED = new Decimal(0);

  evaluate(inputs: RouteInputs): RouteOutcome {
    const selection = inputs.select();
    if (selection.kind === 'selected') {
      return settleOnPrint(inputs, selection, {
        route: this.identifier,
        costBp: CorporateActionTerminalRoute.CHARGED,
      });
    }
    if (inputs.multiplierDrifted) {
      return new RouteOutcome({
        route: this.identifier,
        action: SettlementAction.VOID_AT_HALF,
        branch: SettlementBranch.CORPORATE_ACTION_TERMINAL,
        payoffWad: WAD / 2n,
        selected: undefined,
        costBp: CorporateActionTerminalRoute.CHARGED,
        rationale:
          'the reference terminated and no print arrived; there is no future print to defer to, ' +
          'so the terminal branch pays half',
      });
    }
    return new RouteOutcome({
      route: this.identifier,
      action: SettlementAction.DEFER,
      branch: SettlementBranch.DEFERRED,
      payoffWad: undefined,
      selected: undefined,
      costBp: CorporateActionTerminalRoute.CHARGED,
      rationale: 'no print and no corporate action; the session stays expired',
    });
  }
}
