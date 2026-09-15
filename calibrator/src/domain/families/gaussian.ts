/**
 * The Gaussian family: the rejected seed.
 *
 * Implemented rather than omitted, because the brief's §4.2.4 rejects it on a *measurement* — "it
 * prices the overnight session 29 to 42% rich" — and a rejection that cannot be re-measured is a
 * preference. The family is here so that the error it makes is reproducible against whatever sample is
 * in hand, and so that the differential suite has a closed form to check the Solidity side against.
 *
 * Why it fails is worth stating precisely, because it is not that the Gaussian is wrong about
 * volatility. It is that the payoff is a function of the *truncated* absolute moment, and that moment
 * depends on the shape of the distribution above the cap as well as on its scale. Measured overnight
 * excess kurtosis is 30.7, so a Gaussian fitted to the same variance places far less mass above the cap
 * than the data does — and the premium is the area under the payoff, so it comes out rich by exactly
 * the mass the Gaussian puts in the wrong place.
 */

import { Decimal } from 'decimal.js';

import { WAD } from '../constants.js';
import { D, truncatedAbsMoment } from '../moments.js';
import {
  type DistributionFamily,
  FamilyError,
  FamilyFit,
  floorDiv,
  type GapSample,
  premiumFromTruncatedMean,
} from './base.js';

/** `WAD` as a decimal, for the conversions below. Derived, never written down a second time. */
const WAD_DECIMAL = new D(WAD.toString());

/** A normal fitted to the sample's mean and variance. */
export class GaussianFamily implements DistributionFamily {
  readonly name = 'gaussian';

  /** Not the seed, and the brief forbids it as one. */
  readonly isSeedModel = false;

  /**
   * `lambda * E[min(|G|, 1/lambda)]` for `G ~ N(0, sigma^2)`.
   *
   * The closed form of paper Eq (12), evaluated by the same primitive the differential fixture checks
   * the Solidity implementation against. Delegating rather than re-deriving is what keeps one
   * implementation of the formula in the repository.
   */
  premiumWad(lamWad: bigint, sample: GapSample): bigint {
    return gaussianPremiumWad(lamWad, sample.sigmaWad());
  }

  fit(lamWad: bigint, sample: GapSample): FamilyFit {
    return new FamilyFit({
      family: this.name,
      lamWad,
      premiumWad: this.premiumWad(lamWad, sample),
      observations: sample.count,
    });
  }
}

/**
 * The Gaussian premium from a sigma, without a sample.
 *
 * Exposed because the differential fixture carries `(sigma, lambda)` rather than a sample, and the
 * fixture is what the Solidity side is checked against. A second entry point rather than a second
 * implementation: both call `truncatedAbsMoment`.
 */
export function gaussianPremiumWad(lamWad: bigint, sigmaWad: bigint): bigint {
  const moment = truncatedAbsMoment(dimensionless(lamWad), new D(0), dimensionless(sigmaWad));
  return premiumFromTruncatedMean(lamWad, toWad(moment));
}

/** A WAD integer as the dimensionless `Decimal` the moment primitive takes. */
export function dimensionless(wadValue: bigint): Decimal {
  return new D(wadValue.toString()).div(WAD_DECIMAL);
}

/**
 * A dimensionless `Decimal` back at WAD scale, rounded half-even.
 *
 * Half-even rather than truncated: the primitive computes at fifty digits and the WAD grid has
 * eighteen, so a quantisation is unavoidable and the cost is half a wei either way. Truncating would
 * bias every premium downwards, and a one-signed bias in the direction of cheapness is the wrong one
 * for a protocol that writes the premium into a bond.
 *
 * Note the direction is the *opposite* of `GapSample.sigmaWad`, which truncates. Both are what the
 * Python does and neither is a slip: a standard deviation is a screening quantity and a premium is
 * money, and the Python rounds only the second.
 */
export function toWad(value: Decimal): bigint {
  return BigInt(value.times(WAD_DECIMAL).toNearest(1, Decimal.ROUND_HALF_EVEN).toFixed(0));
}

/**
 * `(estimated - reference) / reference`, signed, at WAD scale.
 *
 * Signed, because the direction of a model's error is the interesting part: the Gaussian's error is
 * one-signed and positive, which is what "prices the overnight session rich" means, and an unsigned
 * error would hide the one property that made the family unusable as a seed.
 *
 * The division floors, as the Python's `//` does. This is the site where that matters: the
 * light-tailed sample below produces a *negative* numerator, so truncation toward zero would report a
 * different wei from the oracle.
 */
export function relativeErrorWad(estimated: bigint, reference: bigint): bigint {
  if (reference === 0n) {
    throw new FamilyError('a relative error needs a non-zero reference');
  }
  return floorDiv((estimated - reference) * WAD, reference);
}
