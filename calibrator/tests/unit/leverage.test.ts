/**
 * Unit tests for the leverage rule and the cap lattice.
 *
 * Ported from `calibrator/tests/unit/test_leverage.py`, which has 26 tests; this file has 30. Four
 * departures, each stated rather than silent:
 *
 *  - `capForLeverage`'s guard is asserted twice, in two tests rather than one. The Python puts both
 *    in a single test; the convention here is one assertion per test, because two refusals in one
 *    test is how coverage attributes the first as covered and the second as not.
 *  - The quantile's upper bound (`probability > 1`) is asserted, which the Python does not. Its own
 *    reasoning for the split above applies to two bounds of one rule as much as to two functions.
 *  - The lattice round-trip runs over **every** leverage from 2 to 100, not the nine the Python
 *    samples. It is the same property, and the breadth is the point: a round trip that fails on some
 *    inputs and not others is the shape that let the on-chain version look correct — two, four and
 *    five pass under a naive implementation and only the leverages whose cap does not divide `1e36`
 *    fail (DESIGN_NOTES.md F26). Verified against the Python before being written here: it holds for
 *    all 99 values. It does **not** catch anything the nine sampled values miss — the two
 *    implementations that round the reciprocal differently both round-trip, and disagree only on
 *    lattice points, which `latticeLeverage` covers.
 *  - The saturation rate's precision is asserted, which pins the decision F57 records. The Python's
 *    value depended on its caller's decimal context, so there was nothing to pin.
 */

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { ROUNDING_LATTICE_WAD, WAD } from '../../src/domain/constants.js';
import {
  capForLeverage,
  empiricalQuantile,
  isOnHarmonicLadder,
  latticeLeverage,
  leverageForCap,
  realisedSaturationRate,
  roundCapUpToLattice,
  saturationGap,
} from '../../src/domain/leverage.js';
import { Wad } from '../../src/domain/models.js';

/** A whole-number leverage, `units`. */
const whole = (units: number): Wad => Wad.fromWhole(BigInt(units));

/** `numerator / denominator` at WAD scale, exactly, the way the Python's `n * WAD // d` does it. */
const ratio = (numerator: bigint, denominator: bigint): Wad =>
  Wad.fromRaw((numerator * WAD) / denominator);

const d = (value: string): Decimal => new Decimal(value);

describe('the empirical quantile', () => {
  it('takes the nearest rank', () => {
    const sample = Array.from({ length: 10 }, (_, index) => ratio(BigInt(index + 1), 10n));
    expect(empiricalQuantile(sample, d('0.5')).equals(ratio(5n, 10n))).toBe(true);
    expect(empiricalQuantile(sample, d('0.99')).equals(ratio(10n, 10n))).toBe(true);
  });

  it('returns the only observation of a single-observation sample', () => {
    const only = whole(3);
    expect(empiricalQuantile([only], d('0.99')).equals(only)).toBe(true);
  });

  it('is independent of the input order', () => {
    const sample = [5, 1, 7, 3, 2].map((index) => ratio(BigInt(index), 7n));
    const ascending = [...sample].sort((left, right) =>
      left.raw < right.raw ? -1 : left.raw > right.raw ? 1 : 0,
    );
    expect(empiricalQuantile(sample, d('0.8')).equals(empiricalQuantile(ascending, d('0.8')))).toBe(
      true,
    );
  });

  it('refuses an empty sample', () => {
    // A default here would become a leverage, and a leverage built on an absent sample is a
    // parameter the protocol would price against.
    expect(() => empiricalQuantile([], d('0.99'))).toThrow(/at least one observation/);
  });

  it('refuses a probability of zero', () => {
    expect(() => empiricalQuantile([Wad.fromRaw(WAD)], d('0'))).toThrow(/probability/);
  });

  it('refuses a probability above one', () => {
    expect(() => empiricalQuantile([Wad.fromRaw(WAD)], d('1.0000001'))).toThrow(/probability/);
  });
});

describe('the cap and the leverage', () => {
  it('takes the cap as the reciprocal of the leverage', () => {
    expect(capForLeverage(whole(15)).equals(Wad.fromRaw(WAD / 15n))).toBe(true);
    expect(capForLeverage(whole(1)).equals(Wad.fromRaw(WAD))).toBe(true);
    expect(capForLeverage(whole(100)).equals(Wad.fromRaw(WAD / 100n))).toBe(true);
  });

  it('floors the leverage for a cap', () => {
    // Floored, not rounded: a leverage above 1/cap saturates more often than the stated alpha.
    expect(leverageForCap(Wad.fromRaw(WAD / 15n)).equals(whole(15))).toBe(true);
    expect(leverageForCap(Wad.fromRaw(WAD / 15n + 1n)).equals(whole(14))).toBe(true);
  });

  it('round-trips on the lattice', () => {
    for (const units of [1, 4, 10, 11, 15, 16, 22, 32, 100]) {
      const lam = whole(units);
      expect(leverageForCap(capForLeverage(lam)).equals(lam), `leverage ${String(units)}`).toBe(
        true,
      );
    }
  });

  it('round-trips every leverage from two to a hundred', () => {
    // The whole range, not a sample. The reciprocal of a cap that does not divide 1e36 is short by
    // whole wei, so only some leverages fail under a naive implementation and a small sample passes.
    const failures: number[] = [];
    for (let units = 2; units <= 100; units += 1) {
      const lam = whole(units);
      if (!leverageForCap(capForLeverage(lam)).equals(lam)) failures.push(units);
    }
    expect(failures).toStrictEqual([]);
  });

  it('refuses a cap that is not positive', () => {
    expect(() => leverageForCap(Wad.zero)).toThrow(/positive/);
  });

  it('refuses a leverage of zero when taking the reciprocal', () => {
    expect(() => capForLeverage(Wad.zero)).toThrow(/a leverage must be positive/);
  });

  it('refuses a negative leverage when taking the reciprocal', () => {
    expect(() => capForLeverage(Wad.fromRaw(-1n))).toThrow(/a leverage must be positive/);
  });
});

describe('the saturation gap', () => {
  // The threshold the saturation predicate uses, which rounds the other way to the reciprocal.

  it('rounds up to the smallest saturating gap', () => {
    // 1/15 is 66666666666666666.67 wei, so the threshold is ...667. Rounding down would place it a
    // wei below the true crossing and make the saturation count disagree with the payoff.
    expect(saturationGap(whole(15)).equals(Wad.fromRaw(66666666666666667n))).toBe(true);
    expect(saturationGap(whole(1)).equals(Wad.fromRaw(WAD))).toBe(true);
    expect(saturationGap(whole(100)).equals(Wad.fromRaw(WAD / 100n))).toBe(true);
    expect(saturationGap(whole(32)).equals(ratio(3125n, 100_000n))).toBe(true);
  });

  it('is never below the reciprocal', () => {
    // They agree only when lambda divides 1e36, which is rare. The gap is never smaller.
    for (const units of [1, 2, 4, 10, 11, 15, 16, 22, 32, 100]) {
      const lam = whole(units);
      expect(
        saturationGap(lam).greaterThanOrEqual(capForLeverage(lam)),
        `leverage ${String(units)}`,
      ).toBe(true);
    }
  });

  it('differs from the reciprocal when the leverage does not divide the square', () => {
    // A leverage of 15 is the canonical case: 15 does not divide 1e36, so the two differ by a wei.
    const lam = whole(15);
    const gap = saturationGap(lam);
    const reciprocal = capForLeverage(lam);
    expect(gap.equals(reciprocal)).toBe(false);
    expect(gap.sub(reciprocal).equals(Wad.fromRaw(1n))).toBe(true);
  });

  it('does not saturate a gap one wei below the threshold', () => {
    const lam = whole(15);
    const threshold = saturationGap(lam);
    const below = Wad.fromRaw(threshold.raw - 1n);
    expect(below.raw < threshold.raw).toBe(true);
    // The payoff's own crossing, expressed as the leverage times the gap, agrees with the threshold
    // rather than with the reciprocal.
    expect(lam.mul(below).toRaw() / WAD < WAD).toBe(true);
  });

  it('refuses a leverage that is not positive', () => {
    expect(() => saturationGap(Wad.zero)).toThrow(/positive/);
  });
});

describe('the rounding lattice', () => {
  const lattice = Wad.fromRaw(ROUNDING_LATTICE_WAD);

  it('rounds up', () => {
    // 1/15 is 6.667%, whose 0.25% grid neighbours are 6.5% and 6.75%. Up means 6.75%.
    expect(roundCapUpToLattice(ratio(1n, 15n), lattice).equals(ratio(675n, 10_000n))).toBe(true);
    // 1/20 is exactly 5.00%, which is already a grid point.
    expect(roundCapUpToLattice(ratio(1n, 20n), lattice).equals(ratio(50n, 1000n))).toBe(true);
  });

  it('leaves an on-grid cap alone', () => {
    const onGrid = ratio(25n, 1000n);
    expect(roundCapUpToLattice(onGrid, lattice).equals(onGrid)).toBe(true);
  });

  it('rounds up rather than to the nearest point', () => {
    // The direction is load-bearing. A larger cap is a smaller leverage, which saturates less often;
    // rounding to nearest would put half the published leverages on the unsafe side of the one number
    // the rule exists to control. A cap one wei above a grid point must therefore move to the *next*
    // grid point, not back to the nearer one.
    const justOver = Wad.fromRaw((25n * WAD) / 1000n + 1n);
    expect(roundCapUpToLattice(justOver, lattice).equals(ratio(275n, 10_000n))).toBe(true);
  });

  it("reproduces the paper's published lattice sensitivity", () => {
    // Paper §6.1: "a 1% lattice gives lambdaE = 16, a 0.5% lattice gives 18, and 0.25% gives the
    // published 19." Reconstructed from a pre-lattice cap of 5.155%, i.e. a raw leverage of about
    // 19.4. This is the check that the rule is the paper's rule.
    const rawCap = ratio(51_550n, 1_000_000n);
    const published: readonly (readonly [string, bigint, number])[] = [
      ['0.01', WAD / 100n, 16],
      ['0.005', WAD / 200n, 18],
      ['0.0025', WAD / 400n, 19],
    ];
    for (const [spacing, spacingWad, expected] of published) {
      const lam = latticeLeverage(rawCap, Wad.fromRaw(spacingWad));
      expect(lam.toRaw() / WAD, `grid ${spacing}`).toBe(BigInt(expected));
    }
  });

  it('refuses a spacing that is not positive', () => {
    expect(() => roundCapUpToLattice(Wad.fromRaw(WAD), Wad.zero)).toThrow(/spacing/);
  });
});

describe('the harmonic ladder', () => {
  it('holds whole leverages', () => {
    for (const units of [1, 4, 10, 11, 15, 16, 22, 32, 100]) {
      expect(isOnHarmonicLadder(whole(units)), `leverage ${String(units)}`).toBe(true);
    }
  });

  it('does not hold fractional leverages', () => {
    expect(isOnHarmonicLadder(Wad.fromRaw(WAD / 2n))).toBe(false);
    expect(isOnHarmonicLadder(Wad.zero)).toBe(false);
  });

  it("holds the paper's canonical set", () => {
    // Every leverage in the paper's Table 13, which is the fixture the lattice gate must not reject.
    // The build brief's "harmonic lattice of integer leverages" would refuse six of these nine; see
    // DESIGN_NOTES.md F2.
    for (const units of [15, 11, 22, 11, 10, 16, 22, 11, 32]) {
      expect(isOnHarmonicLadder(whole(units)), `leverage ${String(units)}`).toBe(true);
    }
  });
});

describe('the realised saturation rate', () => {
  it('always saturates a constant series above the cap', () => {
    const sample = Array.from({ length: 10 }, () => ratio(1n, 10n)); // every gap is 10%
    expect(realisedSaturationRate(sample, whole(15)).eq(new Decimal(1))).toBe(true);
  });

  it('never saturates a constant series below the cap', () => {
    const sample = Array.from({ length: 10 }, () => ratio(1n, 100n)); // every gap is 1%
    expect(realisedSaturationRate(sample, whole(15)).eq(new Decimal(0))).toBe(true);
  });

  it('reports the rate at the domain precision rather than an ambient one', () => {
    // One of three saturating, so the rate is a third and its digits *are* the precision. The Python
    // divided through the `decimal` module's ambient context, so it returned 28 significant digits
    // from a plain call and 50 from inside a caller's `localcontext` — and 60 after importing
    // `tools/gen_constants.py`, which sets `getcontext().prec = 60` at module scope. Same arguments,
    // different value, depending on the process. The port states the precision instead
    // (DESIGN_NOTES.md F57), and this asserts that it is the stated one.
    const sample = [ratio(1n, 10n), ratio(1n, 100n), ratio(2n, 100n)];
    const digits = realisedSaturationRate(sample, whole(15)).toString().replace('0.', '');
    expect(digits).toBe('3'.repeat(50));
  });

  it('refuses an empty sample', () => {
    expect(() => realisedSaturationRate([], whole(15))).toThrow(/at least one observation/);
  });
});
