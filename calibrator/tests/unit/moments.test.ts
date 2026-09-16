/**
 * The distributional primitives, at unit level.
 *
 * The Python's `calibrator/tests/unit/test_moments.py` has 22 tests. **Eleven of them are already
 * asserted in `calibrator/tests/contract/moments.test.ts`**, which absorbed them when the port
 * reorganised the two Python digest/moments files into one TypeScript file per source module. This
 * file is the other eleven, and the mapping is recorded here because "which Python test covers this"
 * is otherwise a question nobody can answer without reading both files:
 *
 * | Python test | Where it lives now |
 * |---|---|
 * | `pdf is even`, `cdf origin`, `cdf monotone and bounded` | `contract/moments.test.ts` |
 * | `absMoment zero sigma`, `firstMoment zero sigma` | `contract/moments.test.ts`, one test |
 * | `zero leverage is the untruncated mean` | `contract/moments.test.ts`, both moments |
 * | `rejects a non-zero mean`, `cap form refuses a zero sigma` | `contract/moments.test.ts` |
 * | `the two coefficients differ by sqrt(2)` | `contract/moments.test.ts` |
 * | `matches the paper equation twelve` | **the fixture**, and more strongly — `contract/moments.test.ts`
 *   compares `momentWad` at full WAD precision where the Python quantised to 12 places |
 * | everything else | here |
 *
 * The Python's own header states the standard every test below is held to, and it is worth carrying
 * over verbatim: *"Every expectation here is an externally checkable value — a published table, a
 * textbook constant, or a limit the paper states — rather than a value read back from the
 * implementation. A test that asserts what the code already does is a change detector, not a test."*
 *
 * Two port notes. `localcontext(prec=60)` becomes a `Decimal.clone` named `WIDE`, because
 * `Decimal.set` would be a mutable global and `moments.ts` says the domain may not have one. And
 * `Decimal.quantize(Decimal("1e-15"))` becomes `toDecimalPlaces(15)`, which returns a value whose
 * `toString` drops a trailing zero — so the tabulated values below are compared with `equals` rather
 * than as strings, since the Python's `1.96` entry ends in one.
 */

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  D,
  erf,
  ERF_SATURATION,
  SQRT_PI,
  SQRT_TWO,
  SQRT_TWO_OVER_PI,
  SQRT_TWO_PI,
  standardNormalCdf,
  standardNormalPdf,
  truncatedAbsMoment,
  truncatedFirstMoment,
  TWO_OVER_SQRT_PI,
} from '../../src/domain/moments.js';

/**
 * A 60-digit clone, for the constant-consistency assertions only.
 *
 * The Python used `localcontext(prec=60)`. At the module's own 50 digits the products below would
 * round to exactly the value they are compared against, so the comparison would hold trivially and
 * would measure nothing. A clone is the port's equivalent of a local context.
 */
const WIDE = Decimal.clone({ precision: 60 });

/** A relative difference, which is the only form these bounds can take on finite literals. */
function within(actual: Decimal, expected: Decimal, tolerance: string): boolean {
  return actual.minus(expected).abs().div(expected).lt(new WIDE(tolerance));
}

describe('standardNormalPdf', () => {
  it('matches the published table at 0 and at 1', () => {
    // Both are tabulated constants, not values read back from this module. The contract file checks the
    // origin through the identity `phi(0) * sqrt(2) * sqrt(pi) == 1`, which is a different claim: it
    // cross-checks the three stored roots against each other and would still hold if all three were
    // wrong together.
    expect(standardNormalPdf(D(0)).toDecimalPlaces(15).toString()).toBe('0.398942280401433');
    expect(standardNormalPdf(D(1)).toDecimalPlaces(15).toString()).toBe('0.241970724519143');
  });
});

describe('standardNormalCdf', () => {
  it('matches the published table at plus and minus 1.96', () => {
    expect(standardNormalCdf(D('1.96')).toDecimalPlaces(15).equals(D('0.975002104851780'))).toBe(
      true,
    );
    expect(standardNormalCdf(D('-1.96')).toDecimalPlaces(15).equals(D('0.024997895148220'))).toBe(
      true,
    );
  });

  it('reaches the deep tail instead of losing it to cancellation', () => {
    // Phi(-7) = 1.279812543885835004383623690780832998035e-12. The continued-fraction branch is what
    // makes this reachable: the Maclaurin series would have lost every digit to cancellation here, and
    // the value would come back as zero. Compared relatively, because a fixed number of decimal places
    // is coarser than this magnitude.
    const trueValue = new WIDE('1.279812543885835004383623690780832998035E-12');
    const computed = new WIDE(standardNormalCdf(D('-7')));
    expect(within(computed, trueValue, '1e-40')).toBe(true);
  });
});

describe('erf', () => {
  it('is exactly one at and above the saturation point (F88)', () => {
    // erfc(11) = 1.5e-54, which is zero at the module's 50 digits. The continued fraction is pure
    // cost past here; short-circuiting was measured at 29.2% of the NIG quadrature's Phi arguments.
    expect(erf(ERF_SATURATION).equals(D(1))).toBe(true);
    expect(erf(D(100)).equals(D(1))).toBe(true);
    expect(erf(ERF_SATURATION.neg()).equals(D(-1))).toBe(true);
  });

  it('is still below one just under the saturation point', () => {
    // The short-circuit must not fire early: the continued fraction is what keeps Phi(-7) honest,
    // and the band between SERIES_BREAKPOINT and ERF_SATURATION is where it earns its keep. At the
    // module's 50 digits erf(10.5) is still distinguishable from 1; erf(10.9) already is not.
    expect(erf(D('10.5')).lt(D(1))).toBe(true);
  });
});

describe('truncatedAbsMoment', () => {
  it('is monotone decreasing in leverage', () => {
    // A larger leverage means a smaller cap, and truncating harder cannot raise the mean. Sigma is 20%
    // rather than a realistic session volatility because the property is only exercised where the caps
    // actually bind: at sigma = 2%, a cap of 1 and a cap of 1/64 truncate nothing at all, so the two
    // moments agree to fifty digits and the ordering is vacuous rather than false.
    const sigma = D('0.2');
    let previous = truncatedAbsMoment(D(1), D(0), sigma);
    for (const lam of ['2', '4', '8', '16', '32', '64']) {
      const current = truncatedAbsMoment(D(lam), D(0), sigma);
      expect(current.lt(previous), `leverage ${lam} must truncate harder than the one before`).toBe(
        true,
      );
      previous = current;
    }
  });

  it('is monotone increasing in sigma', () => {
    // A wider distribution has a larger absolute moment at a fixed cap. No fixture point asserts this:
    // the fixture is a set of independent inputs, and monotonicity is a relation between them.
    let previous = D(0);
    for (const sigma of ['0.005', '0.01', '0.02', '0.04', '0.08']) {
      const current = truncatedAbsMoment(D(15), D(0), D(sigma));
      expect(current.gt(previous), `sigma ${sigma} must exceed the one before`).toBe(true);
      previous = current;
    }
  });
});

describe('the constants', () => {
  it('has the Maclaurin coefficient as 2 / sqrt(pi)', () => {
    // Finite literals cannot be exactly consistent, so the assertion is a relative bound rather than
    // equality. 1e-45 is well inside the 50 digits the constants carry and far below any quantity this
    // module computes.
    const product = new WIDE(TWO_OVER_SQRT_PI).times(new WIDE(SQRT_PI));
    expect(within(product, new WIDE(2), '1e-45')).toBe(true);
  });

  it('has the absolute-mean coefficient as sqrt(2 / pi)', () => {
    // E[|Z|] for a standard normal is sqrt(2/pi). Multiplying it by pi gives sqrt(2*pi), the other
    // constant in this module, so the relationship is checkable without restating either value.
    const pi = new WIDE('3.14159265358979323846264338327950288419716939937510582097494');
    const product = new WIDE(SQRT_TWO_OVER_PI).times(pi);
    expect(within(product, new WIDE(SQRT_TWO_PI), '1e-45')).toBe(true);
  });

  it('has sqrt(pi) and sqrt(2 pi) consistent', () => {
    const ratio = new WIDE(SQRT_TWO_PI).div(new WIDE(SQRT_PI));
    expect(within(ratio, new WIDE(SQRT_TWO), '1e-45')).toBe(true);
  });

  it('carries more digits than the default context precision', () => {
    // A module-level constant computed with a division would be evaluated in the default context and
    // would silently cap every downstream result, so the literals have to be longer than it. The
    // default differs between the two languages — CPython's `decimal` carries 28 significant digits and
    // `decimal.js` carries 20 — and 40 is below both, so the same bound means the same thing here as it
    // did in the Python. This is the one assertion in this file that would pass in a language whose
    // default was 45, which is why the number is stated rather than derived.
    const constants: readonly (readonly [string, Decimal])[] = [
      ['SQRT_PI', SQRT_PI],
      ['SQRT_TWO', SQRT_TWO],
      ['SQRT_TWO_PI', SQRT_TWO_PI],
      ['TWO_OVER_SQRT_PI', TWO_OVER_SQRT_PI],
      ['SQRT_TWO_OVER_PI', SQRT_TWO_OVER_PI],
    ];
    for (const [name, value] of constants) {
      expect(value.sd(), `${name} carries only ${String(value.sd())} digits`).toBeGreaterThan(40);
    }
  });
});

describe('the fair premium', () => {
  it('has the truncated first moment as its numeric derivative', () => {
    // dp/dlambda = E[|G| 1{|G| <= 1/lambda}], which is the derivative of p = lambda * moment. Checked as
    // a central difference, because the identity is a derivative and asserting it any other way would be
    // asserting a restatement. The tolerance is loose because a central difference is second-order.
    const sigma = D('0.0188');
    const lam = D(15);
    const step = D('0.0001');
    const upper = lam.plus(step).times(truncatedAbsMoment(lam.plus(step), D(0), sigma));
    const lower = lam.minus(step).times(truncatedAbsMoment(lam.minus(step), D(0), sigma));
    const numeric = upper.minus(lower).div(step.times(2));
    const analytic = truncatedFirstMoment(lam, sigma);
    expect(within(numeric, analytic, '1e-6')).toBe(true);
  });

  it('is below the untruncated first moment', () => {
    // Truncation can only remove mass, so the capped first moment is strictly smaller wherever the cap
    // binds — which at sigma = 2% and lambda = 15 it does.
    const sigma = D('0.02');
    const untruncated = truncatedFirstMoment(D(0), sigma);
    expect(truncatedFirstMoment(D(15), sigma).lt(untruncated)).toBe(true);
  });
});
