/**
 * The leverage rule and the cap lattice.
 *
 * `lambda* = 1 / Q_(1-alpha)(|G|)` with `alpha = 0.01`. The rule has a deliberate safety property:
 * `P(lambda* |G| >= 1) = alpha`, so saturation happens by construction rather than by accident.
 *
 * The rounding lattice is the second half of the rule and is easy to miss. The published leverage
 * values depend on the grid the cap is rounded to — a 1% grid gives 16, a 0.5% grid gives 18, and
 * 0.25% gives the published 19 — so the grid is load-bearing and is stated in `spec/constants.yaml`.
 * The traded strikes are a different object again: the harmonic ladder of caps of the form `1/n`,
 * because on the published 0.25% grid 68 of 79 caps are not listed markets (paper §6.1, Table 26).
 *
 * Pure: a sequence of gaps in, a leverage out. No `Math` and no `number` arithmetic — every quantity
 * below is a `bigint` at WAD scale, and the two places a decimal is genuinely needed, the quantile's
 * rank and the saturation rate, go through `decimal.js`.
 *
 * **The saturation rate's precision is stated, not inherited.** The Python computes that one ratio
 * through the `decimal` module's *ambient* context, so the same call returns 28 significant digits
 * normally and 50 inside a caller's `localcontext` — measured, and recorded as DESIGN_NOTES.md F57.
 * A `Decimal.clone` carries its own precision, so the port cannot reproduce that accident, and it
 * constructs through the domain's single decimal constructor rather than declaring a second one.
 */

import type { Decimal } from 'decimal.js';

import { WAD } from './constants.js';
import { Wad } from './models.js';
import { D } from './moments.js';

/** Thrown by a rule that refuses its input. */
export class LeverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeverageError';
  }
}

/**
 * Ascending order on raw values.
 *
 * `Array.prototype.sort` is lexicographic by default, so `10n` would sort before `9n` — and the
 * values here are gaps, so the default would order a ten-wei gap before a nine-wei one. It is wrong
 * on exactly the comparisons that are hardest to notice, which is why the comparator is explicit.
 */
function ascending(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The value at `index`, or a refusal naming the rank.
 *
 * `noUncheckedIndexedAccess` types every index as possibly absent, and the arithmetic in the caller
 * proves this one present: `probability` lies in `(0, 1]` and the sample is non-empty, so the rank
 * lies in `[1, length]`. The type checker cannot see that, and the alternatives are worse — a cast
 * would hide a mistake if the guard were ever loosened, and a silent `undefined` would become a
 * leverage. So the boundary states what an out-of-range rank means instead of asserting it away:
 * the caller's arithmetic was wrong. This is a guard at the access rather than a re-check of the
 * guard above, which is the same placement `Amm`'s reserve check has (DESIGN_NOTES.md F44/F45).
 */
function rankedValue(ordered: readonly bigint[], index: number): bigint {
  const value = ordered[index];
  if (value === undefined) {
    throw new LeverageError(
      `rank ${String(index + 1)} is outside a sample of ${String(ordered.length)}`,
    );
  }
  return value;
}

/**
 * The `probability` quantile of `observations`, by the nearest-rank rule.
 *
 * Nearest-rank rather than an interpolating definition because the quantity being estimated is an
 * order statistic that the leverage rule then floors: interpolation would invent precision the
 * published integer cannot carry, and would put a value between two observed gaps.
 *
 * Refuses an empty sample rather than returning a default. A default here would become a leverage,
 * and a leverage built on an absent sample is a parameter the protocol would price against (build
 * brief §8.4, "silent failure").
 */
export function empiricalQuantile(observations: readonly Wad[], probability: Decimal): Wad {
  if (observations.length === 0) {
    throw new LeverageError('a quantile needs at least one observation');
  }
  if (!probability.gt(0) || probability.gt(1)) {
    throw new LeverageError('probability must lie in (0, 1]');
  }

  const ordered = observations.map((observation) => observation.raw).sort(ascending);
  const rank = probability.times(ordered.length).ceil().toNumber();
  return Wad.fromRaw(rankedValue(ordered, rank - 1));
}

/**
 * `floor(1 / cap)`, as a whole-number leverage.
 *
 * Floored rather than rounded: a leverage above `1 / cap` would saturate more often than the stated
 * `alpha`, and the rule's whole purpose is that the saturation probability is a chosen number rather
 * than an observed one.
 *
 * The quotient is floored **in WAD units** rather than the reciprocal being rounded. That is not a
 * stylistic choice: for a leverage of three the cap is `333333333333333334` and its exact reciprocal
 * is `2999999999999999994`, six whole wei short of three, so no care in rounding the reciprocal
 * recovers it. Rounding the quotient gives three. Found on the Solidity side, where the same rule
 * lives in `SessionFactory.checkListingCap`; see DESIGN_NOTES.md F26.
 */
export function leverageForCap(cap: Wad): Wad {
  if (cap.raw <= 0n) {
    throw new LeverageError('a cap must be positive');
  }
  const units = (WAD * WAD) / cap.raw;
  return Wad.fromRaw((units / WAD) * WAD);
}

/**
 * `1 / lambda`, the saturation point, rounded down.
 *
 * The reciprocal, used for reporting a cap as a percentage and for the lattice rule. This is *not*
 * the threshold the saturation predicate uses — see `saturationGap`, which rounds the other way for
 * a reason.
 */
export function capForLeverage(lam: Wad): Wad {
  if (lam.raw <= 0n) {
    throw new LeverageError('a leverage must be positive');
  }
  return Wad.fromRaw((WAD * WAD) / lam.raw);
}

/**
 * The smallest gap at which `lambda |G| >= 1`, i.e. `ceil(1 / lambda)`.
 *
 * Rounded **up**, unlike `capForLeverage`, and the direction is load-bearing. This is the threshold,
 * so it must be the smallest gap that saturates. `capForLeverage` is the reciprocal and rounds down;
 * the two differ by one wei whenever `lambda` does not divide `1e36`, which is almost always. Using
 * the rounded-down value as a threshold would place it a wei below the true crossing and make the
 * saturation count disagree with the payoff.
 *
 * `ceil(a / b)` is written `(a + b - 1) / b` rather than imported from `Math`, which would introduce
 * a float conversion for a quantity that must stay exact.
 */
export function saturationGap(lam: Wad): Wad {
  if (lam.raw <= 0n) {
    throw new LeverageError('a leverage must be positive');
  }
  const numerator = WAD * WAD;
  return Wad.fromRaw((numerator + lam.raw - 1n) / lam.raw);
}

/**
 * Round a cap **up** to the grid.
 *
 * Up, not to nearest, and the direction is load-bearing: a larger cap is a smaller leverage, which
 * saturates less often. Rounding to nearest would put half the published leverages on the unsafe
 * side of the stated saturation probability, which is the one number the rule exists to control.
 */
export function roundCapUpToLattice(cap: Wad, lattice: Wad): Wad {
  if (lattice.raw <= 0n) {
    throw new LeverageError('a lattice spacing must be positive');
  }
  const steps = (cap.raw + lattice.raw - 1n) / lattice.raw;
  return Wad.fromRaw(steps * lattice.raw);
}

/**
 * The published leverage: round the cap up to the grid, then floor the reciprocal.
 *
 * This is the rule that reproduces the paper's 16 / 18 / 19 for a 1% / 0.5% / 0.25% grid. It is the
 * reason the grid has to be stated: the same measured quantile publishes three different leverages
 * depending on a parameter the design originally left implicit.
 */
export function latticeLeverage(rawCap: Wad, lattice: Wad): Wad {
  return leverageForCap(roundCapUpToLattice(rawCap, lattice));
}

/**
 * Whether a leverage is a whole number, i.e. its cap is exactly `1/n`.
 *
 * The harmonic ladder is the set of *traded* strikes. The rounding grid is not the ladder: it is the
 * coarser set the cap is snapped to before the reciprocal is taken, and most of its points are not
 * listable markets.
 */
export function isOnHarmonicLadder(lam: Wad): boolean {
  return lam.raw > 0n && lam.raw % WAD === 0n;
}

/**
 * The share of sessions on which `lambda |G| >= 1`.
 *
 * The rule's own validity check. Fed measured inputs it should return the stated `alpha`; fed the
 * design's illustrative inputs it did not — at the design's overnight leverage the session saturated
 * on 2.74% of sessions against an advertised 1%, which is a safety error rather than a
 * competitiveness one (paper §7.3).
 *
 * The result is a `Decimal` rather than a `Wad` because it is a rate and not a quantity: it is
 * compared against `alpha` and reported, and nothing prices off it. That is also the one place in
 * this module where the precision is observable, and it comes from the domain's single decimal
 * constructor — see the note at the head of this file.
 */
export function realisedSaturationRate(observations: readonly Wad[], lam: Wad): Decimal {
  if (observations.length === 0) {
    throw new LeverageError('a saturation rate needs at least one observation');
  }
  const threshold = saturationGap(lam);
  const saturated = observations.filter((observation) => observation.raw >= threshold.raw).length;
  return new D(saturated).div(new D(observations.length));
}
