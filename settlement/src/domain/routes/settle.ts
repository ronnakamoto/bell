/**
 * The shared settling path: adjust for a corporate action, then price the gap.
 *
 * Every route that settles on a print goes through here, since the multiplier adjustment is guard G8
 * and is not a route's choice. What a route *does* choose is what happens when no print qualifies,
 * which is where the five differ and where the cost comparison lives.
 *
 * Split out of `base.ts` when that file crossed §8.1's 400-line limit, and the seam is worth stating
 * because it is not arbitrary: `base.ts` is the vocabulary and the inputs — the route identifiers, the
 * action and branch sets, `RouteInputs`, `RouteOutcome` — and this module is the one piece of
 * behaviour all five share. It depends on `base.ts` and not the reverse, so the edge is one-way.
 *
 * `payoffLongWad` mirrors `contracts/src/libraries/Payoff.sol`. A second implementation is a
 * divergence risk, so the two are held together by the differential suite rather than by convention —
 * and this one is the reference the contract is checked against.
 */

import { WAD } from '@bell/calibrator/domain/constants.js';
import { type Decimal } from 'decimal.js';

import { type PrintSelected } from '../prints.js';
import {
  type RouteId,
  type RouteInputs,
  RouteOutcome,
  SettlementAction,
  SettlementBranch,
} from './base.js';

/**
 * `min(lambda * |G|, 1)`, the long claim's terminal payoff at WAD scale.
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
 * The shared settling path.
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
