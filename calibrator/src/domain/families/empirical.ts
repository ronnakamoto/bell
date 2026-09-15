/**
 * The empirical truncated distribution: the seed model.
 *
 * The paper's §5.3 makes this the primary model and the brief's §4.2.4 makes it the seed, and the
 * reason is that it assumes nothing. Every fitted family is scored against this one — the Gaussian
 * prices the overnight premium 29 to 42% rich *relative to it*, the NIG closes to within 2.4% *of it* —
 * so the reference has to be the measurement rather than another model.
 *
 * The estimator is `E[min(|G|, c)]` computed on the raw gaps, with `c = 1/lambda` the saturation point.
 * Computed on the raw gaps and not on pre-truncated values: a sample whose values were already capped
 * cannot recover the mass above the cap, and the whole reason the cap matters is that the payoff stops
 * growing there.
 */

import { WAD } from '../constants.js';
import {
  type DistributionFamily,
  FamilyFit,
  floorDiv,
  type GapSample,
  premiumFromTruncatedMean,
  truncatedMeanWad,
} from './base.js';

/** The seed model: the truncated mean taken directly from the sample. */
export class EmpiricalTruncatedFamily implements DistributionFamily {
  readonly name = 'empirical';
  readonly isSeedModel = true;

  premiumWad(lamWad: bigint, sample: GapSample): bigint {
    const capWad = floorDiv(WAD * WAD, lamWad);
    return premiumFromTruncatedMean(lamWad, truncatedMeanWad(sample, capWad));
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
