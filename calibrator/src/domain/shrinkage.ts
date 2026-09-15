/**
 * The event session's parameter set: shrink the multiplier, then place the leverage.
 *
 * **The specification is "pool the shape, keep the scale"** (paper §7.10). The event session cannot
 * support a per-name empirical quantile — 34 observations against 7.2 expected tail draws — but the
 * two quantities it conflates have opposite characters. Measured excess kurtosis in the event session
 * is −0.08 ± 0.48 against 13.24 ± 0.06 for the non-event pool, so the *shape* is homogeneous and
 * near-Gaussian; the *scale* is name-specific and estimable, because the name's own level is pinned
 * by roughly 2,479 non-event observations and only the ratio carries event information. The rule
 * therefore places the leverage from the pooled shape applied to the name's own shrunk event scale.
 *
 * `lambda_C = floor(1 / (q_C * r* * sigma_nonC))`. That is the same rule `leverage.ts` implements —
 * `lambda* = 1 / Q_(1-alpha)(|G|)` — with the empirical quantile replaced by the parametric one
 * `q_C * sigma`. The substitution is the whole architecture of the section: a quantile needs the tail,
 * a scale does not. The paper measures the cost of getting this wrong at 13.8% one-signed bias in `Q`
 * for the per-name empirical route, against −0.4% for this one.
 *
 * **The estimator.** `r*_i = w_i * r_i + (1 - w_i) * mu`, with `w_i = tau^2 / (tau^2 + SE(r_i)^2)`
 * and `mu` the cross-sectional mean of `r`. Three things about it are measured rather than assumed,
 * and all three are recorded in `DESIGN_NOTES.md` F89:
 *
 * - **The target is the plain unweighted mean.** Solving the published column for the target each name
 *   implies gives 4.363776 to 4.379700 across the 22, centred on `mean(r) = 4.371590909...`. The whole
 *   spread is explained by the quantisation of the published inputs: the implied target's sensitivity
 *   is `1 / (1 - w)`, which is 62x for XOM and 3.3x for NFLX, so a 5e-4 rounding in `r*` becomes
 *   exactly the deviation observed. The precision-weighted mean is 3.253, which is nothing like it.
 * - **`tau` is the method-of-moments estimator** `sqrt(var(r) - mean(SE(r)^2))` over the 22 names,
 *   with the *sample* variance (`n - 1`): 1.596142018792765... The `n` form gives 1.554552 and the
 *   uncorrected `sqrt(var(r))` gives 1.697890; neither reproduces the published column. **The constant
 *   is the unrounded value, not the brief's 1.596**, and that is a measurement rather than a
 *   preference: Table 17's own `r*` column resolves the fourth digit. Fitting `tau` to that column by
 *   least squares puts the minimum at 1.596337 — 0.012% from the MM estimator, so the two routes agree
 *   — and the rounded 1.596 is 4.0% worse in rms (6.2% worse than the optimum), missing the published
 *   third decimal on two names where the unrounded value misses on one. The paper's §7.10 body rounds
 *   it to 1.58, which is 17x worse and misses 18 of 22. F9 closed this on the estimator and F89 on the
 *   fourth digit.
 * - **`tau^2 / mean(SE^2)` is 7.6x**, which is why the shrinkage is mild: the weight spans 0.693 to
 *   0.984 and only the extremes move materially. The paper's prose says 6.7x, which is the same two
 *   digits transposed; the ratio is what the weights depend on and the weights reproduce the column.
 *
 * **What the published column reproduces.** All 22 `lambda_C` exactly, from the published 2-dp
 * `sigma_C*`. All 22 `r*` to within 1.0e-3, which is the bound the published precision permits and not
 * a tolerance chosen to fit: the input `r` is quantised at 3 dp and the output `r*` is too, so the
 * discrepancy is bounded by the sum of the two half-steps, 5e-4 + 5e-4. Measured worst is NVDA at
 * 9.2866e-4, 93% of that bound, and 21 of 22 also agree to the published third decimal — NVDA being
 * the single exception, which is the same one-unit discrepancy the bound is sized for. The interval
 * column reproduces 21 of 22; KO misses by one lattice step on the low end (17.98 against 18), and the
 * gap is 0.017 of a step against a `sigma_C*` published at 2 dp whose own quantisation is ±0.23%.
 *
 * **The interval uses the shrunk point estimate and the *raw* standard error.** `r* ± SE(r)`, not
 * `r* ± SE(r*)`. Measured against all five candidates: `r* ± SE(r)` misses 1 of 22, `r* ± SE(r*)`
 * misses 5, `r ± SE(r)` misses 8, and a `tau`-inflated form misses 10. The choice is also the
 * conservative one, which is the direction a published uncertainty band should err.
 *
 * Pure: a multiplier and its standard error in, a leverage out. No `Math`, no `number` arithmetic —
 * every quantity is a `bigint` at WAD scale, and the one ratio goes through `decimal.js`.
 */

import type { Decimal } from 'decimal.js';

import {
  EVENT_SESSION_CROSS_SECTIONAL_TAU_WAD,
  EVENT_SESSION_POOLED_SHAPE_Q_WAD,
  WAD,
} from './constants.js';
import { dimensionless, toWad } from './families/gaussian.js';
import { Wad } from './models.js';
import { D } from './moments.js';

/** Thrown by a rule that refuses its input. */
export class ShrinkageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShrinkageError';
  }
}

const WAD_DECIMAL = new D(WAD.toString());

/** `tau`, dimensionless, at the domain's working precision. */
const TAU = new D(EVENT_SESSION_CROSS_SECTIONAL_TAU_WAD.toString()).div(WAD_DECIMAL);

/** `tau^2`, the numerator of every weight. Computed once, since it cannot vary. */
const TAU_SQUARED = TAU.times(TAU);

const ONE = new D(1);

/**
 * The cross-sectional mean the multiplier shrinks toward.
 *
 * Floored at WAD scale rather than rounded. The quantity is an average of ratios the caller has
 * already quantised, the difference is one wei, and `toWad`'s half-even rounding would be a second
 * convention in a module that has no money in it. It is the *target* of a shrink, so a one-wei
 * displacement is absorbed by `(1 - w)` before it can reach a leverage.
 *
 * Refuses an empty universe rather than returning a default. There is no sensible pooled mean of no
 * names, and a default here would become the target every name is shrunk toward — a parameter the
 * protocol would price against, built on nothing (build brief §8.4, "silent failure").
 */
export function pooledMultiplier(multipliers: readonly Wad[]): Wad {
  if (multipliers.length === 0) {
    throw new ShrinkageError('a pooled multiplier needs at least one name');
  }
  let total = 0n;
  for (const multiplier of multipliers) total += multiplier.raw;
  return Wad.fromRaw(total / BigInt(multipliers.length));
}

/**
 * `tau^2 / (tau^2 + SE^2)`, the weight the name's own measurement carries.
 *
 * A `Decimal` rather than a `Wad`, for the reason `realisedSaturationRate` is: it is a rate and not a
 * quantity. Nothing prices off it and it is reported alongside the estimate.
 *
 * A standard error of exactly zero gives a weight of one, i.e. no shrinkage. That is the correct limit
 * — a measurement with no uncertainty is not improved by being moved — and it is not reachable from
 * the measured inputs, where the smallest standard error is 0.205 against a multiplier of 1.714. A
 * *negative* standard error is refused: it is not a small uncertainty, it is a sign error, and
 * squaring it would hide that.
 */
export function shrinkageWeight(standardError: Wad): Decimal {
  if (standardError.raw < 0n) {
    throw new ShrinkageError('a standard error cannot be negative');
  }
  const squared = dimensionless(standardError.raw).pow(2);
  return TAU_SQUARED.div(TAU_SQUARED.plus(squared));
}

/**
 * `r* = w * r + (1 - w) * mu`, the shrunk event multiplier.
 *
 * A convex combination, so the result always lies between the name's own measurement and the
 * cross-section — shrinkage cannot manufacture a value outside the range it was given. The
 * multiplication is done in `Decimal` and quantised once at the end by `toWad`, rather than in
 * `bigint`, because `w` is a fifty-digit ratio and truncating it before it meets `r` would bias every
 * shrunk value toward the pooled mean by an amount that depends on the name.
 *
 * `pooled` is a parameter rather than a module-level constant because it is a property of the
 * *universe* and not of this rule: the same name shrunk toward a different launch list is a different
 * estimate, and that should be visible at the call site rather than hidden in the module.
 */
export function shrunkMultiplier(multiplier: Wad, standardError: Wad, pooled: Wad): Wad {
  const weight = shrinkageWeight(standardError);
  const shrunk = weight
    .times(dimensionless(multiplier.raw))
    .plus(ONE.minus(weight).times(dimensionless(pooled.raw)));
  return Wad.fromRaw(toWad(shrunk));
}

/**
 * `sigma_C* = r* * sigma_nonC`, the event scale the shrunk multiplier implies.
 *
 * Floored, matching the WAD product convention the rest of the domain uses. This is the quantity
 * Table 17 publishes to two decimal places, and it is the *only* place the unpublished
 * `sigma_nonC` enters — which is why the leverage below takes the scale and not the pair.
 */
export function eventScale(multiplier: Wad, nonEventScale: Wad): Wad {
  return Wad.fromRaw((multiplier.raw * nonEventScale.raw) / WAD);
}

/**
 * `floor(1 / (q_C * sigma_C*))`, the event-session leverage.
 *
 * **Takes the scale, not `(r*, sigma_nonC)`.** The two are algebraically the same rule, since
 * `sigma_C* = r* * sigma_nonC`, but `sigma_nonC` is not a published quantity while `sigma_C*` is. A
 * signature that demanded the unpublished input would force every check against Table 17 to
 * reconstruct it from the output it is trying to check, which is a test that cannot fail. The
 * composition is the caller's, and `eventScale` above is the step it makes.
 *
 * Floored, for the reason `leverageForCap` floors: a leverage above `1 / Q` saturates more often than
 * the stated `alpha`, and the saturation probability is the one number the rule exists to control.
 *
 * Refuses a non-positive scale rather than returning zero: the quotient would be a division by zero
 * dressed as an infinite leverage, and an infinite leverage is a cap of zero.
 */
export function eventLeverage(eventScale: Wad): Wad {
  if (eventScale.raw <= 0n) {
    throw new ShrinkageError('an event leverage needs a positive scale');
  }
  const lambda = (WAD * WAD * WAD) / (EVENT_SESSION_POOLED_SHAPE_Q_WAD * eventScale.raw);
  return Wad.fromWhole(lambda / WAD);
}

/**
 * The published band on the leverage, from the uncertainty on the multiplier alone.
 *
 * `floor(1 / (q_C * sigma_C* * (1 ± SE / r*)))`, i.e. the leverage at `(r* ± SE(r)) * sigma_nonC`.
 * The band is on the *leverage* and not on the scale, so the two ends are not symmetric about the
 * point estimate in lattice steps: the high-`r*` end has the smaller leverage, and the floor makes the
 * two ends round independently.
 *
 * Returns `[low, high]`, ascending, which means the `+SE` end comes first. The caller does not have to
 * remember which direction the standard error pushes the leverage — a band whose ends were ordered by
 * the arithmetic rather than by the result would be a trap for a reader who assumed the usual
 * convention.
 *
 * Refuses `SE >= r*`. At equality the low end is a division by zero and below it the lower leverage is
 * negative, and a negative leverage is not a wide band — it is a sign error. Not reachable from the
 * measured inputs, where the widest ratio is XOM's 0.205 against 1.757.
 */
export function eventLeverageBand(
  eventScale: Wad,
  multiplier: Wad,
  standardError: Wad,
): readonly [Wad, Wad] {
  if (standardError.raw < 0n) {
    throw new ShrinkageError('a standard error cannot be negative');
  }
  if (standardError.raw >= multiplier.raw) {
    throw new ShrinkageError('a leverage band needs a multiplier larger than its standard error');
  }
  const relative = dimensionless(standardError.raw).div(dimensionless(multiplier.raw));
  const atUpperMultiplier = eventLeverage(scaleForRelative(eventScale, ONE.plus(relative)));
  const atLowerMultiplier = eventLeverage(scaleForRelative(eventScale, ONE.minus(relative)));
  // Ascending, and the order is not the obvious one: the *upper* multiplier gives the *smaller*
  // leverage, because the leverage is the reciprocal of the scale. Returning the pair in the order the
  // arithmetic produces it would hand back a descending interval that reads as an error at the call
  // site — and did, in this module's first draft, where the two locals were named `high` and `low` for
  // the ends they were computed from rather than the ends they are.
  return [atUpperMultiplier, atLowerMultiplier];
}

/**
 * `scale * factor`, at WAD scale, floored.
 *
 * A `Decimal` factor because it is a ratio and not a quantity, and because the alternative — a second
 * `bigint` multiply-divide — would put the flooring convention in two places.
 */
function scaleForRelative(scale: Wad, factor: Decimal): Wad {
  return Wad.fromRaw(toWad(dimensionless(scale.raw).times(factor)));
}
