/**
 * The pricing primitive, checked against the shared differential fixture.
 *
 * The counterpart is `contracts/test/differential/Moments.t.sol`. The values in
 * `spec/fixtures/moments.json` were produced by the Python reference at 50 significant digits and are
 * committed, so what this file establishes is that the TypeScript reproduces them exactly — not that
 * it agrees with a re-derivation of itself. That is the difference between a port and a rewrite.
 *
 * The other half of the contract — whether the on-chain approximation agrees with this reference
 * inside the derived tolerance — belongs to the Solidity test, and is asserted there.
 */

import { readFileSync } from 'node:fs';

import type { Decimal } from 'decimal.js';

import { describe, expect, it } from 'vitest';

import {
  D,
  SQRT_PI,
  SQRT_TWO,
  SQRT_TWO_OVER_PI,
  TWO_OVER_SQRT_PI,
  standardNormalCdf,
  standardNormalPdf,
  truncatedAbsMoment,
  truncatedAbsMomentAtCap,
  truncatedFirstMoment,
} from '../../src/domain/moments.js';

interface MomentPoint {
  lambdaWad: string;
  sigmaWad: string;
  capWad: string;
  momentWad: string;
  premiumWad: string;
  firstMomentWad: string;
  toleranceWei: string;
}

interface MomentsFixture {
  pointCount: number;
  points: MomentPoint[];
}

/** The fields that must be strings, so a value above 2^53 cannot be silently rounded (F52). */
const INTEGER_FIELDS: readonly (keyof MomentPoint)[] = [
  'lambdaWad',
  'sigmaWad',
  'capWad',
  'momentWad',
  'premiumWad',
  'firstMomentWad',
  'toleranceWei',
];

const fixture: MomentsFixture = JSON.parse(
  readFileSync(new URL('../../../spec/fixtures/moments.json', import.meta.url), 'utf8'),
) as MomentsFixture;

const WAD = new D(10).pow(18);

/**
 * Quantise to the WAD grid, half-even.
 *
 * The reference is computed at 50 significant digits and the WAD grid has 18 decimal places, so a
 * quantisation is unavoidable. It costs at most half a wei, which is eleven orders of magnitude below
 * the 1.5e-7 tolerance the fixture is used to assert.
 *
 * Returned as a `bigint` rather than a `number`: the whole point of the exercise is that these values
 * exceed what a double can hold, so quantising into one would undo the work.
 */
function quantise(value: Decimal): bigint {
  return BigInt(value.times(WAD).toFixed(0, D.ROUND_HALF_EVEN));
}

const lamOf = (point: MomentPoint): Decimal => new D(point.lambdaWad).div(WAD);
const sigmaOf = (point: MomentPoint): Decimal => new D(point.sigmaWad).div(WAD);

describe('the moments fixture', () => {
  it('is the size it says it is', () => {
    expect(fixture.points.length).toBe(fixture.pointCount);
    expect(fixture.points.length).toBe(112);
  });

  it('carries every integer as a string, so no value is above 2^53 as a number', () => {
    // 109 of the 112 points have a `premiumWad` above JavaScript's safe integer limit and all 112
    // have at least one field above it. A bare JSON number would be silently rounded here and the
    // comparison below would then pass or fail by luck. See DESIGN_NOTES.md F52.
    for (const point of fixture.points) {
      for (const field of INTEGER_FIELDS) {
        expect(typeof point[field]).toBe('string');
        expect(BigInt(point[field])).toBeGreaterThan(0n);
      }
    }
  });
});

describe('truncatedAbsMoment', () => {
  it('reproduces every point in the fixture', () => {
    for (const point of fixture.points) {
      const lam = lamOf(point);
      const sigma = sigmaOf(point);
      const moment = truncatedAbsMoment(lam, D(0), sigma);
      expect(quantise(moment)).toBe(BigInt(point.momentWad));
    }
  });

  it('reproduces the fair premium, lambda times the moment', () => {
    for (const point of fixture.points) {
      const lam = lamOf(point);
      const sigma = sigmaOf(point);
      const premium = lam.times(truncatedAbsMoment(lam, D(0), sigma));
      expect(quantise(premium)).toBe(BigInt(point.premiumWad));
    }
  });

  it('agrees with the cap form on the same input', () => {
    for (const point of fixture.points) {
      const lam = lamOf(point);
      const sigma = sigmaOf(point);
      expect(quantise(truncatedAbsMomentAtCap(new D(1).div(lam), sigma))).toBe(
        BigInt(point.momentWad),
      );
    }
  });

  it('has the cap as the reciprocal of the leverage', () => {
    for (const point of fixture.points) {
      expect(quantise(new D(1).div(lamOf(point)))).toBe(BigInt(point.capWad));
    }
  });
});

describe('truncatedFirstMoment', () => {
  it('reproduces every point in the fixture', () => {
    for (const point of fixture.points) {
      expect(quantise(truncatedFirstMoment(lamOf(point), sigmaOf(point)))).toBe(
        BigInt(point.firstMomentWad),
      );
    }
  });
});

describe('the stated limits', () => {
  it('is zero at zero sigma', () => {
    expect(truncatedAbsMoment(D(15), D(0), D(0)).toFixed()).toBe('0');
    expect(truncatedFirstMoment(D(15), D(0)).toFixed()).toBe('0');
  });

  it('is the untruncated absolute mean at zero leverage', () => {
    // The paper's stated c -> infinity limit, which is what makes the two branches continuous.
    const sigma = new D('0.0188');
    expect(truncatedAbsMoment(D(0), D(0), sigma).eq(sigma.times(SQRT_TWO_OVER_PI))).toBe(true);
    expect(truncatedFirstMoment(D(0), sigma).eq(sigma.times(SQRT_TWO_OVER_PI))).toBe(true);
  });

  it('refuses a non-zero mean rather than approximating it', () => {
    expect(() => truncatedAbsMoment(D(15), D(1), D('0.02'))).toThrow(/zero mean only/);
  });

  it('refuses a zero sigma in the cap form', () => {
    expect(() => truncatedAbsMomentAtCap(D('0.05'), D(0))).toThrow(/non-zero sigma/);
  });
});

describe('the normal primitives', () => {
  it('has a density whose origin value is 1 / sqrt(2 pi)', () => {
    // `phi(0) * sqrt(2) * sqrt(pi) == 1`, which cross-checks `SQRT_TWO_PI` — a stored 60-digit
    // literal — against the product of the two other stored roots. Asserted with a tolerance rather
    // than by equality: the three are derived differently, so they agree to about 49 digits and not
    // to the last one. An exact comparison there would test the constants' last digit rather than
    // the identity.
    const reconstructed = standardNormalPdf(D(0)).times(SQRT_TWO).times(SQRT_PI);
    expect(reconstructed.minus(1).abs().lt(d('1e-45'))).toBe(true);
  });

  it('is even in its argument', () => {
    expect(standardNormalPdf(D('1.5')).eq(standardNormalPdf(D('-1.5')))).toBe(true);
  });

  it('has a cdf of one half at the origin', () => {
    expect(standardNormalCdf(D(0)).toFixed(30)).toBe(D('0.5').toFixed(30));
  });

  it('has a cdf that is monotone and bounded', () => {
    let previous = D(0);
    for (let x = -6; x <= 6; x += 0.5) {
      const value = standardNormalCdf(D(x));
      expect(value.gte(previous)).toBe(true);
      expect(value.gte(0) && value.lte(1)).toBe(true);
      previous = value;
    }
  });
});

describe('the constants', () => {
  it('are internally consistent', () => {
    // The two coefficients are one substitution apart and the substitution is silent: `2/sqrt(pi)`
    // is the error function's Maclaurin coefficient and `sqrt(2/pi)` is `E[|Z|]`. A swap between
    // them shifts every result by 29%, and this is the assertion that catches it. It caught exactly
    // that during the original build; see DESIGN_NOTES.md F16.
    //
    // `2/sqrt(pi)` divided by `sqrt(2/pi)` is `2/sqrt(2)` = `sqrt(2)`.
    const ratio = TWO_OVER_SQRT_PI.div(SQRT_TWO_OVER_PI);
    expect(ratio.minus(SQRT_TWO).abs().lt(d('1e-45'))).toBe(true);
  });

  it('has the two coefficients distinguishable', () => {
    expect(TWO_OVER_SQRT_PI.gt(D(1))).toBe(true);
    expect(SQRT_TWO_OVER_PI.lt(D(1))).toBe(true);
    expect(TWO_OVER_SQRT_PI.eq(SQRT_TWO_OVER_PI)).toBe(false);
  });
});

/** Local shorthand, kept at the foot so the assertions above read as arithmetic. */
function d(value: string): Decimal {
  return new D(value);
}
