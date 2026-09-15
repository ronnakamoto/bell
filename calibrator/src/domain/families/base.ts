/**
 * The distributional family strategy, and the sample it is fitted to.
 *
 * Four families are named in the paper — Gaussian, Student-t, normal-inverse-Gaussian and Merton
 * jump-diffusion — and the brief's §5.2 names the family set as one of the two places a **Strategy**
 * is required, because it is an open set that must be selectable and comparable at runtime. The
 * comparison is the point: the paper's Table 18 ranks them on their premium error against the
 * empirical distribution, and a family that is not implemented cannot be ranked.
 *
 * `GapSample` carries the raw gaps rather than a summary. The empirical family is the seed model and
 * it needs every observation, and a fitted family needs enough to estimate its own parameters — so a
 * sample reduced to a mean and a variance at the boundary would decide the family question before the
 * family was chosen.
 *
 * **This package does not import `models.ts`, and that is deliberate.** The Python's four family
 * modules import `constants` and `moments` and nothing else; the port reproduces the import graph as
 * well as the behaviour, so every quantity here is a bare `bigint` at WAD scale and each name carries
 * the scale in its suffix. `Wad` exists for a caller holding a *price*; a gap sample is a raw
 * measurement at a stated scale.
 *
 * **Division floors, because Python's `//` does.** `bigint`'s `/` truncates toward zero and the two
 * disagree by one whenever the quotient is negative and inexact — see `floorDiv`, which is not
 * defensive coding but a translation of the operator. `relativeErrorWad` is negative for the
 * light-tailed sample its own test asserts, so this is a wei on a published quantity.
 *
 * **The decimal work runs at the domain's declared precision, not an ambient one.** The Python
 * computes `sigma_wad` through `decimal`'s ambient context — the same defect `DESIGN_NOTES.md` F57
 * records for `realised_saturation_rate`, at a further site. The port states the precision through the
 * domain's single decimal constructor. Unlike F57 the difference is not observable: both this function
 * and `to_wad` quantise to an integer, and the ambient error is around 1e-11 of a wei. Recorded as F60
 * rather than left implicit, because "it happens not to show" is not the same as "it is not there".
 */

import { type Decimal } from 'decimal.js';

import { WAD } from '../constants.js';
import { D } from '../moments.js';

/** Thrown by the family layer when it refuses its input. */
export class FamilyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FamilyError';
  }
}

/**
 * Thrown for a family the paper names and this repository does not implement.
 *
 * A distinct type rather than a `FamilyError`, because the two failures mean different things: an
 * unknown name is a typo, while the absence of NIG is F10 (closed: fallback, not production) and
 * tracker G0, and the message has to say so. The Python separates them as `NotImplementedError` and
 * `KeyError`; this is the same separation with names that read as errors.
 */
export class UnimplementedFamilyError extends FamilyError {
  constructor(message: string) {
    super(message);
    this.name = 'UnimplementedFamilyError';
  }
}

/**
 * Floor division, as Python's `//` means it.
 *
 * `bigint`'s `/` truncates toward zero, so the two disagree by one whenever the quotient is negative
 * and not exact: `(-1n) / 3n` is `0n`, where `-1 // 3` is `-1`. Every `//` in the Python is translated
 * to this rather than to `/`, so the port is behaviourally identical on inputs the tests never reach.
 */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const inexact = numerator % denominator !== 0n;
  const signsDiffer = numerator < 0n !== denominator < 0n;
  return inexact && signsDiffer ? quotient - 1n : quotient;
}

/** Ascending order on raw values, since `sort` is lexicographic by default (`10n` before `9n`). */
function ascending(left: bigint, right: bigint): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** A WAD-scale `bigint` as the `Decimal` the arithmetic below takes. */
function dec(value: bigint): Decimal {
  return new D(value.toString());
}

/**
 * A set of observed gaps, at WAD scale.
 *
 * Immutable, and it validates once at construction rather than at every use: a sample with no
 * observations is refused here, so no family has to decide what to do with one. "The sample cannot
 * support an estimate" is a domain result, but an *empty* sample is a programmer error.
 */
export class GapSample {
  readonly gapsWad: readonly bigint[];

  constructor(gapsWad: readonly bigint[]) {
    if (gapsWad.length === 0) {
      throw new FamilyError('a gap sample needs at least one observation');
    }
    this.gapsWad = gapsWad;
  }

  get count(): number {
    return this.gapsWad.length;
  }

  /** `|G|` for every observation, which is what the payoff and the leverage rule both read. */
  get magnitudesWad(): readonly bigint[] {
    return this.gapsWad.map((gap) => (gap < 0n ? -gap : gap));
  }

  /**
   * The sample standard deviation, at WAD scale.
   *
   * The population form — dividing by `n` rather than `n - 1` — because the sample is the whole of
   * what the window holds rather than a draw from a larger population, and because a
   * one-observation sample would divide by zero under the other convention. A one-observation sample
   * is admitted here and refused by the caller, which is the layer that can say why.
   *
   * **The result is truncated, not rounded, and that is load-bearing.** `int(variance.sqrt())` in the
   * Python truncates toward zero; a port that reached for `toFixed(0)` would round half-up and differ
   * by one wei on roughly half of all samples. Measured on the three-gap sample below, the square
   * root is `9392668535736913.8996...`, so truncation gives `...913` and rounding gives `...914`.
   */
  sigmaWad(): bigint {
    const n = new D(this.count);
    let total = 0n;
    for (const gap of this.gapsWad) total += gap;
    const mean = dec(total).div(n);

    let squares = new D(0);
    for (const gap of this.gapsWad) {
      const deviation = dec(gap).minus(mean);
      squares = squares.plus(deviation.times(deviation));
    }
    return BigInt(squares.div(n).sqrt().trunc().toFixed(0));
  }

  /**
   * The `probability` quantile of `|G|`, by the nearest-rank rule.
   *
   * Mirrors `leverage.empiricalQuantile` but over magnitudes, because the leverage rule reads
   * `Q_(1-alpha)(|G|)` and the sign of a gap is not a volatility quantity. The rule is written out
   * here rather than imported, as the Python writes it out: `leverage.ts` orders `Wad` values and this
   * orders raw integers, and importing across the two would put an edge in the graph that the oracle
   * does not have. The duplication is checked rather than trusted — `families.test.ts` asserts the two
   * agree on a non-negative sample.
   */
  quantileMagnitudeWad(probability: Decimal): bigint {
    if (!probability.gt(0) || probability.gt(1)) {
      throw new FamilyError('probability must lie in (0, 1]');
    }
    const ordered = [...this.magnitudesWad].sort(ascending);
    const rank = probability.times(ordered.length).ceil().toNumber();
    const value = ordered[rank - 1];
    // The same guard as `leverage.ts`'s `rankedValue`, at this file's own copy of the nearest-rank
    // rule, and unreachable for the same reason one layer further down: `GapSample` refuses an empty
    // sample at construction and `probability` is refused outside `(0, 1]` here, so `rank` lies in
    // `[1, n]`. Kept for the reason the whole port keeps its depth guards — the caller that is wrong
    // is the one it exists for — and hinted rather than tested, because reaching it would mean
    // constructing a `Family` whose sample is empty, which is the state `GapSample` exists to make
    // unrepresentable.
    /* v8 ignore next 5 */
    if (value === undefined) {
      throw new FamilyError(
        `rank ${String(rank)} is outside a sample of ${String(ordered.length)}`,
      );
    }
    return value;
  }
}

/** A family's estimate of the fair premium, and the leverage it was asked about. */
export class FamilyFit {
  readonly family: string;
  readonly lamWad: bigint;
  readonly premiumWad: bigint;
  readonly observations: number;

  constructor(fields: {
    family: string;
    lamWad: bigint;
    premiumWad: bigint;
    observations: number;
  }) {
    this.family = fields.family;
    this.lamWad = fields.lamWad;
    this.premiumWad = fields.premiumWad;
    this.observations = fields.observations;
  }

  /** The premium as a fraction of the notional, which is what the registry publishes. */
  get premiumPerUnitWad(): bigint {
    return this.premiumWad;
  }
}

/**
 * One distributional family.
 *
 * An `interface` rather than an abstract class, which is what the Python's `Protocol` means: a family
 * is any object with these members, so a numerical routine that lives in an adapter can satisfy it
 * without importing the domain.
 */
export interface DistributionFamily {
  /** The family's name, as the paper's Table 18 lists it. */
  readonly name: string;

  /**
   * Whether the paper names this as the seed model.
   *
   * Exactly one family is the seed, and the flag exists so that "which family produced this published
   * parameter" is answerable from the parameter set rather than from a comment.
   */
  readonly isSeedModel: boolean;

  /**
   * The fair premium of the long claim at this leverage, at WAD scale.
   *
   * `lambda * E[min(|G|, 1/lambda)]`. The family decides how the expectation is taken — from the
   * sample directly, or from a fitted density — and nothing else about the answer changes.
   */
  premiumWad(lamWad: bigint, sample: GapSample): bigint;

  /** The premium, wrapped with the family's name and the observation count. */
  fit(lamWad: bigint, sample: GapSample): FamilyFit;
}

/**
 * `E[min(|G|, cap)]` taken directly from the sample.
 *
 * The seed model's estimator, and the reference every fitted family is scored against. Computed on the
 * raw gaps so that the cap is a true truncation rather than a mean of pre-truncated values — the
 * distinction the paper's appendix is explicit about, because a pre-truncated mean cannot recover the
 * mass above the cap that the payoff depends on.
 */
export function truncatedMeanWad(sample: GapSample, capWad: bigint): bigint {
  if (capWad <= 0n) {
    throw new FamilyError('a truncation cap must be positive');
  }
  let total = 0n;
  for (const magnitude of sample.magnitudesWad) {
    total += magnitude < capWad ? magnitude : capWad;
  }
  return floorDiv(total, BigInt(sample.count));
}

/** `lambda * E[min(|G|, 1/lambda)]`, floored to the collateral unit at WAD scale. */
export function premiumFromTruncatedMean(lamWad: bigint, truncatedMean: bigint): bigint {
  return floorDiv(lamWad * truncatedMean, WAD);
}
