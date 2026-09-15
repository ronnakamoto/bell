/**
 * The distributional families.
 *
 * The Gaussian is tested as a *rejection*, not merely as an implementation. The brief rejects it as a
 * seed on a measurement — "it prices the overnight session 29 to 42% rich" — and a rejection that
 * cannot be re-measured is a preference. The tests below build a leptokurtic sample and assert that the
 * Gaussian is rich on it, which is the same finding on a sample this repository holds.
 *
 * Ported from `calibrator/tests/unit/test_families.py`, which has 28 tests in four classes; this file
 * has 33. (It said 31 while it held 32 — a count written by hand and not re-derived, which is why the
 * number is now checked against the file rather than remembered. G0 added one, for the registry move.)
 * Departures, each stated rather than silent:
 *
 *  - **`GapSample` takes `readonly bigint[]`** where the Python takes `tuple[int, ...]`, and `FAMILIES`
 *    is a `Map` where the Python has a `Mapping` — so `FAMILIES['empirical']` reads
 *    `FAMILIES.get('empirical')` through a local helper.
 *  - **The two refusal types are renamed, not merged.** `familyFor('merton')` throws
 *    `UnimplementedFamilyError` where the Python raises `NotImplementedError`, and
 *    `familyFor('nonsense')` throws `FamilyError` where the Python raises `KeyError`. The distinction
 *    is the point of both, so the port keeps two types. The example used to be `familyFor('nig')`,
 *    which is now registered.
 *  - **Three tests are added, each pinning something the Python's own suite cannot catch.** They are
 *    marked below. The first two are ports of a *defect* rather than of a test: `sigmaWad` truncates
 *    and `relativeErrorWad` floors, and neither is observable through the assertions the Python wrote,
 *    because its sigma test uses a perfect square and its relative-error test uses exact divisions.
 */

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { WAD } from '../../src/domain/constants.js';
import {
  type DistributionFamily,
  FAMILIES,
  FamilyError,
  GapSample,
  SEED_FAMILY,
  UNIMPLEMENTED_FAMILIES,
  UnimplementedFamilyError,
  familyFor,
  floorDiv,
  premiumFromTruncatedMean,
  seedFamily,
  truncatedMeanWad,
} from '../../src/domain/families/index.js';
import { gaussianPremiumWad, relativeErrorWad } from '../../src/domain/families/gaussian.js';
import { empiricalQuantile } from '../../src/domain/leverage.js';
import { truncatedAbsMoment } from '../../src/domain/moments.js';
import { Wad } from '../../src/domain/models.js';

/** A decimal literal at WAD scale, exactly, the way the Python's `int(Decimal(v) * WAD)` does it. */
const wad = (value: string): bigint => BigInt(new Decimal(value).times(WAD.toString()).toFixed(0));

/** `FAMILIES[name]`, which the Python indexes directly. */
function at(name: string): DistributionFamily {
  const found = FAMILIES.get(name);
  if (found === undefined) throw new Error(`no family registered as '${name}'`);
  return found;
}

/**
 * A leptokurtic sample, built rather than drawn so the test is deterministic without a seed: 990 gaps
 * of a tenth of a per cent and ten of eight per cent. The shape that matters is not the kurtosis on its
 * own but the ratio of the mean absolute move to the standard deviation — 0.224 here against 0.798 for
 * a normal — because the truncated moment is an average of absolute values, and a fat-tailed
 * distribution puts most of its *variance* in a few observations while most of its *observations* sit
 * far below the mean.
 *
 * The magnitudes below are larger than the paper's measured +29 to +42%, and that is expected: the
 * paper measures real gaps over a 504-session window, and this is a two-point construction chosen to
 * make the direction unambiguous rather than to reproduce the magnitude. The direction is the claim.
 */
const LEPTOKURTIC = new GapSample([
  ...Array.from({ length: 990 }, () => wad('0.001')),
  ...Array.from({ length: 5 }, () => wad('-0.08')),
  ...Array.from({ length: 5 }, () => wad('0.08')),
]);

/**
 * A light-tailed sample: a discrete uniform over +/- 5.9% in steps of a tenth of a per cent. Its excess
 * kurtosis is negative, so the Gaussian's error should carry the opposite sign.
 *
 * The steps go through a `number` and back, exactly as the Python's `f"{step / 1000}"` does. Verified
 * that the two languages produce the same shortest round-trip string for all 59 steps before relying on
 * it — they do.
 */
const PLATYKURTIC = new GapSample([
  ...Array.from({ length: 59 }, (_, index) => wad(String((index + 1) / 1000))),
  ...Array.from({ length: 59 }, (_, index) => wad(String(-(index + 1) / 1000))),
]);

describe('the gap sample', () => {
  it('refuses an empty sample', () => {
    // A programmer error rather than a domain result: "the sample cannot support an estimate" is
    // ordinary, but a sample with nothing in it is a bug in the caller.
    expect(() => new GapSample([])).toThrow(/at least one observation/);
  });

  it('counts the observations', () => {
    expect(new GapSample([1n, 2n, 3n]).count).toBe(3);
  });

  it('takes magnitudes as unsigned', () => {
    expect(new GapSample([-5n, 3n]).magnitudesWad).toEqual([5n, 3n]);
  });

  it('computes the population standard deviation', () => {
    // Two observations at +/- 1% have a population sigma of exactly 1%.
    const sample = new GapSample([wad('0.01'), wad('-0.01')]);
    expect(sample.sigmaWad()).toBe(wad('0.01'));
  });

  it('gives a constant sample a sigma of zero', () => {
    expect(new GapSample(Array.from({ length: 5 }, () => wad('0.01'))).sigmaWad()).toBe(0n);
  });

  it('gives a one-observation sample a sigma', () => {
    // The population form divides by n, so a single observation gives zero rather than dividing by
    // zero. Whether such a sample is *usable* is the caller's question, not this one's.
    expect(new GapSample([wad('0.01')]).sigmaWad()).toBe(0n);
  });

  it('truncates the sigma rather than rounding it', () => {
    // ADDED, and it is the one assertion the Python's sigma tests cannot make: both of theirs land on
    // exact values (a perfect square, and zero), so a port that rounded half-up would pass them. This
    // sample's square root is 9392668535736913.8996..., so truncation gives ...913 and rounding gives
    // ...914. Measured against the oracle at 60 digits before being written here.
    const sample = new GapSample([wad('0.010'), wad('0.021'), wad('0.033')]);
    expect(sample.sigmaWad()).toBe(9392668535736913n);
  });

  it('takes the quantile over magnitudes', () => {
    const sample = new GapSample(
      Array.from({ length: 100 }, (_, index) => wad(String((index + 1) / 100))),
    );
    expect(sample.quantileMagnitudeWad(new Decimal('0.99'))).toBe(wad('0.99'));
  });

  it('orders a sample carrying a repeated magnitude', () => {
    // The equal case of this file's *own* comparator — `families/base.ts` orders the magnitudes
    // independently of `leverage.ts`, and the two `ascending` functions are separate. Both were
    // missing it, and for the same reason: every fixture in both files has distinct values.
    //
    // `magnitudesWad` is unsigned, so `-0.03` and `0.03` are one rank here rather than two, and a
    // comparator that never reported equality would order them by arrival instead of by value. The
    // sign is deliberately mixed in the fixture, so the test also fails if the magnitude is not taken
    // before the sort.
    const sample = new GapSample([wad('-0.03'), wad('0.01'), wad('0.03'), wad('-0.02')]);
    expect(sample.quantileMagnitudeWad(new Decimal('0.5')), 'the middle rank').toBe(wad('0.02'));
    expect(sample.quantileMagnitudeWad(new Decimal('1')), 'the top rank').toBe(wad('0.03'));
  });

  it('agrees with the leverage rule on a non-negative sample', () => {
    // ADDED. `quantileMagnitudeWad` writes the nearest-rank rule out rather than importing
    // `leverage.empiricalQuantile`, because the Python writes it out too and importing across the two
    // would put an edge in the graph the oracle does not have. Two implementations of one rule is a
    // divergence waiting to happen, so the agreement is asserted rather than assumed.
    const sample = new GapSample(
      Array.from({ length: 40 }, (_, index) => wad(String((index + 1) / 100))),
    );
    const asWads = sample.gapsWad.map((raw) => Wad.fromRaw(raw));
    for (const text of ['0.5', '0.9', '0.99', '1']) {
      const probability = new Decimal(text);
      expect(sample.quantileMagnitudeWad(probability)).toBe(
        empiricalQuantile(asWads, probability).raw,
      );
    }
  });

  it('refuses an out-of-range probability', () => {
    expect(() => new GapSample([1n]).quantileMagnitudeWad(new Decimal('0'))).toThrow(/probability/);
  });
});

describe('the empirical seed', () => {
  it('is the seed family', () => {
    expect(seedFamily()).toBe(at(SEED_FAMILY));
    expect(seedFamily().isSeedModel).toBe(true);
  });

  it('has exactly one seed', () => {
    const seeds = [...FAMILIES.entries()].filter(([, family]) => family.isSeedModel);
    expect(seeds.map(([name]) => name)).toEqual([SEED_FAMILY]);
  });

  it('caps every observation at the truncation point', () => {
    // Three observations, a cap of 2%: the 5% one contributes the cap, not its own value.
    const sample = new GapSample([wad('0.01'), wad('0.02'), wad('0.05')]);
    expect(truncatedMeanWad(sample, wad('0.02'))).toBe(
      (wad('0.01') + wad('0.02') + wad('0.02')) / 3n,
    );
  });

  it('recovers the plain mean when the cap is above every observation', () => {
    const sample = new GapSample([wad('0.01'), wad('0.03')]);
    expect(truncatedMeanWad(sample, wad('1.0'))).toBe((wad('0.01') + wad('0.03')) / 2n);
  });

  it('refuses a non-positive cap', () => {
    expect(() => truncatedMeanWad(new GapSample([1n]), 0n)).toThrow(/cap/);
  });

  it('under-reports for a cap other than the one a pre-truncated sample was cut at', () => {
    // The distinction the paper's appendix is explicit about. A sample whose values were already
    // capped has destroyed the mass above that cap, so it can answer for that cap and no other: asked
    // about a wider cap it under-reports, because the observations it would have used are gone. That
    // is why the estimator is documented as running on the raw gaps.
    const raw = new GapSample([wad('0.01'), wad('0.50')]);
    const cutAtFivePerCent = new GapSample([wad('0.01'), wad('0.05')]);
    expect(truncatedMeanWad(raw, wad('0.05'))).toBe(
      truncatedMeanWad(cutAtFivePerCent, wad('0.05')),
    );
    expect(truncatedMeanWad(raw, wad('0.20'))).toBeGreaterThan(
      truncatedMeanWad(cutAtFivePerCent, wad('0.20')),
    );
  });

  it('scales the truncated mean by the leverage', () => {
    const sample = new GapSample(Array.from({ length: 100 }, () => wad('0.01')));
    const lam = 15n * WAD;
    // Every observation is below the cap, so the truncated mean is 1% and the premium is 15%.
    expect(at('empirical').premiumWad(lam, sample)).toBe(
      premiumFromTruncatedMean(lam, wad('0.01')),
    );
    expect(at('empirical').premiumWad(lam, sample)).toBe(wad('0.15'));
  });

  it('carries the family name and the observation count', () => {
    const fit = at('empirical').fit(
      15n * WAD,
      new GapSample(Array.from({ length: 7 }, () => wad('0.01'))),
    );
    expect(fit.family).toBe('empirical');
    expect(fit.observations).toBe(7);
  });

  it('publishes the fit premium per unit', () => {
    // `premiumPerUnitWad` is what the registry publishes, so it must be the fit's premium. Two names
    // for one quantity, and they exist because the fit speaks in premium terms while the commitment
    // speaks per unit of notional. Pinned because a divergence between what a publisher committed and
    // what its own fit produced is the failure the commitment mechanism exists to detect — and a
    // property that drifted would make it silent.
    const fit = at('empirical').fit(
      15n * WAD,
      new GapSample(Array.from({ length: 100 }, () => wad('0.01'))),
    );
    expect(fit.premiumPerUnitWad).toBe(fit.premiumWad);
    expect(fit.premiumPerUnitWad).toBe(wad('0.15'));
  });
});

describe('the Gaussian rejection', () => {
  it('is not the seed', () => {
    expect(at('gaussian').isSeedModel).toBe(false);
  });

  it('is rich on a leptokurtic sample', () => {
    // The brief's §4.2.4 rejection, re-measured. The direction is the interesting part: the error is
    // one-signed and positive, which is what "prices the overnight session rich" means, and an
    // unsigned error would hide the one property that made the family unusable as a seed.
    const lam = 15n * WAD;
    const empirical = at('empirical').premiumWad(lam, LEPTOKURTIC);
    const gaussian = at('gaussian').premiumWad(lam, LEPTOKURTIC);
    expect(gaussian).toBeGreaterThan(empirical);
    expect(relativeErrorWad(gaussian, empirical)).toBeGreaterThan(0n);
  });

  it('has an error that grows with the leverage', () => {
    // A higher leverage means a smaller cap, so more of the sample is above it — and the mass above
    // the cap is exactly what the Gaussian gets wrong. The error is therefore monotone in the
    // leverage, which is worth knowing before publishing a leverage and a premium together.
    const errors = [11, 15, 22, 32].map((lam) => {
      const empirical = at('empirical').premiumWad(BigInt(lam) * WAD, LEPTOKURTIC);
      const gaussian = at('gaussian').premiumWad(BigInt(lam) * WAD, LEPTOKURTIC);
      return relativeErrorWad(gaussian, empirical);
    });
    const ascending = (left: bigint, right: bigint): number =>
      left < right ? -1 : left > right ? 1 : 0;
    expect(errors).toEqual([...errors].sort(ascending));
  });

  it('has an error signed by the tail shape', () => {
    // The family is not wrong; it is wrong about *this* instrument's data. The sign of its error
    // tracks the shape of the tail: rich on a fat-tailed sample and poor on a light-tailed one, which
    // is why no single family can serve both and why the empirical model is the reference every fitted
    // family is scored against.
    const lam = 15n * WAD;
    const fatError = relativeErrorWad(
      at('gaussian').premiumWad(lam, LEPTOKURTIC),
      at('empirical').premiumWad(lam, LEPTOKURTIC),
    );
    const lightError = relativeErrorWad(
      at('gaussian').premiumWad(lam, PLATYKURTIC),
      at('empirical').premiumWad(lam, PLATYKURTIC),
    );
    expect(fatError).toBeGreaterThan(0n);
    expect(lightError).toBeLessThan(0n);
    expect(fatError).toBeGreaterThan(lightError < 0n ? -lightError : lightError);
  });

  it('agrees with the moment primitive', () => {
    // One implementation of Eq (12), not two: the family delegates rather than re-deriving. The
    // conversion is written out here rather than imported, so the test is an independent check of
    // `gaussianPremiumWad` instead of a restatement of it.
    const lamWad = 15n * WAD;
    const sigmaWad = wad('0.0188');
    const asDecimal = (value: bigint): Decimal => new Decimal(value.toString());
    const scale = asDecimal(WAD);
    const moment = truncatedAbsMoment(
      asDecimal(lamWad).div(scale),
      new Decimal(0),
      asDecimal(sigmaWad).div(scale),
    );
    const expected = premiumFromTruncatedMean(
      lamWad,
      BigInt(moment.times(scale).toNearest(1, Decimal.ROUND_HALF_EVEN).toFixed(0)),
    );
    expect(gaussianPremiumWad(lamWad, sigmaWad)).toBe(expected);
  });

  it('reports a signed relative error', () => {
    expect(relativeErrorWad(110n, 100n)).toBe(wad('0.10'));
    expect(relativeErrorWad(90n, 100n)).toBe(wad('-0.10'));
  });

  it('refuses a zero reference', () => {
    expect(() => relativeErrorWad(1n, 0n)).toThrow(/non-zero reference/);
  });
});

describe('the family registry', () => {
  it('names the unimplemented families', () => {
    // The NIG left this set when tracker G0 landed it. It is asserted by *name* rather than by size,
    // because a set that shrank by one for the wrong reason would pass a size check.
    expect([...UNIMPLEMENTED_FAMILIES].sort()).toEqual(['merton', 'student_t']);
  });

  it('refuses an unimplemented family specifically', () => {
    // Not a lookup failure. A missing entry reads as a typo; an unimplemented family is a recorded gap
    // and the error has to say so. The NIG used to be the example here, and is now registered — which
    // is why this test names Merton.
    expect(() => familyFor('merton')).toThrow(UnimplementedFamilyError);
    expect(() => familyFor('merton')).toThrow(/G0/);
  });

  it('no longer refuses the NIG', () => {
    // The other half of the move: a set that still contained 'nig' would make `familyFor('nig')` throw
    // for a family that is registered, which is the failure the two-set split exists to prevent.
    expect(UNIMPLEMENTED_FAMILIES.has('nig')).toBe(false);
    expect(familyFor('nig').name).toBe('nig');
  });

  it('refuses an unknown family as unknown', () => {
    expect(() => familyFor('nonsense')).toThrow(FamilyError);
    // and *not* as unimplemented — the two failures mean different things, which is why the port keeps
    // two types where the Python uses `KeyError` and `NotImplementedError`.
    expect(() => familyFor('nonsense')).not.toThrow(UnimplementedFamilyError);
  });

  it('has every family declare its own name', () => {
    for (const [name, family] of FAMILIES) {
      expect(family.name).toBe(name);
    }
  });
});

describe('floor division', () => {
  it('floors a negative quotient the way Python does', () => {
    // ADDED. `bigint`'s `/` truncates toward zero and the oracle's `//` floors, so the two differ by
    // one whenever the quotient is negative and inexact. That is not theoretical here:
    // `relativeErrorWad` divides a negative numerator for the light-tailed sample above, so this is a
    // wei on a published quantity rather than a case the tests never reach.
    expect(floorDiv(7n, 2n)).toBe(3n);
    expect(floorDiv(-6n, 2n)).toBe(-3n); // exact, so both operators agree
    expect(floorDiv(-7n, 2n)).toBe(-4n); // Python: -7 // 2 == -4, where -7n / 2n is -3n
    expect(floorDiv(-7n, -2n)).toBe(3n); // Python: -7 // -2 == 3
  });
});
