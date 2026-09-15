/**
 * The NIG fallback.
 *
 * **New rather than ported, and the one suite in the port with no oracle behind it.** The Python had
 * no NIG family — `family_for("nig")` raised `NotImplementedError` citing F10 — so there is no
 * `test_families.py` class to reproduce and no differential to run. What stands in for the oracle is
 * arithmetic that is checkable without one, and all four checks below are of that kind:
 *
 *  - **The fit round-trips through the NIG's own cumulants.** The inversion is closed form, so a
 *    sample whose standardised moments are known must return parameters that reproduce them. The
 *    reproduction formulas are written out here rather than imported, which makes this an independent
 *    check of `nigParameters` rather than a restatement of it.
 *  - **The non-central truncated normal moment is checked against `moments.ts`'s central one.** At a
 *    zero mean the two compute the same quantity by different algebraic routes, which is what lets one
 *    be a reference for the other.
 *  - **The mixture quadrature is checked against the Gaussian limit**, where the answer is closed
 *    form. The NIG tends to a normal as `delta` grows with the marginal variance held fixed, and the
 *    measured rate is `1/delta` — so the assertion is on the *rate*, which a quadrature that merely
 *    happened to be close would not reproduce.
 *  - **The quadrature plan is checked against its own closed-form limit**, `sqrt(2*DECAY)`.
 *
 * **The premium itself is asserted as a direction, not a value**, which is what tracker G0 asks for
 * and what `families.test.ts` already does for the Gaussian. The magnitudes on this fixture are far
 * larger than Table 18's −1.1%…+2.4%, for the reason that file already gives for the Gaussian's
 * +29%…+42%: the sample is a two-point construction with an excess kurtosis of 97, chosen to make the
 * direction unambiguous rather than to reproduce the paper's measured regime. What is reproduced is
 * the *ranking* — NIG closer than Gaussian at every leverage — and that is the claim.
 *
 * **Two costs are pinned rather than commented**, because both would otherwise be invisible: the
 * quadrature is called with a measured point count (asserted below), and the fixture is expensive
 * because its excess kurtosis is 97. The suite is slower for it, and the alternative — a fixture tuned
 * until the tests are quick — would be a fixture chosen to make a gate cheap.
 */

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { WAD } from '../../src/domain/constants.js';
import {
  type DistributionFamily,
  FAMILIES,
  GapSample,
  relativeErrorWad,
} from '../../src/domain/families/index.js';
import {
  NigFamily,
  NigParameters,
  nigParameters,
  nigQuadraturePlan,
  nigTruncatedAbsMomentAtCap,
  truncatedAbsMomentForNormal,
} from '../../src/domain/families/nig.js';
import { D, standardNormalCdf, truncatedAbsMomentAtCap } from '../../src/domain/moments.js';

/** A decimal literal at WAD scale, exactly, the way the Python's `int(Decimal(v) * WAD)` does it. */
const wad = (value: string): bigint => BigInt(new Decimal(value).times(WAD.toString()).toFixed(0));

/** A dimensionless decimal at the domain's working precision. */
const d = (value: Decimal.Value): Decimal => new D(value);

/** A decimal as its leading `digits` significant digits, which is how the pins below are written. */
const sig = (value: Decimal, digits: number): string =>
  value.toSignificantDigits(digits).toString();

/** `FAMILIES[name]`, which the Python indexes directly. */
function at(name: string): DistributionFamily {
  const found = FAMILIES.get(name);
  if (found === undefined) throw new Error(`no family registered as '${name}'`);
  return found;
}

/**
 * The leptokurtic two-point sample, restated from `families.test.ts`.
 *
 * Restated rather than shared: the two files pin different properties of it — that one the Gaussian's
 * sign, this one the NIG's ranking — and a shared fixture module would be a third place a sample is
 * written down, which is the thing the restatement avoids being. Its standardised shape is what makes
 * it usable here at all: skewness −0.3712, excess kurtosis 97.06, both measured below rather than
 * quoted.
 */
const LEPTOKURTIC = new GapSample([
  ...Array.from({ length: 990 }, () => wad('0.001')),
  ...Array.from({ length: 5 }, () => wad('-0.08')),
  ...Array.from({ length: 5 }, () => wad('0.08')),
]);

/**
 * The same construction with the tail pushed to one side, so the fit has a *positive* `beta`.
 *
 * The sign of `rho` is the one branch in the inversion that a symmetric or a negatively skewed sample
 * cannot reach, and a branch reached only by the sample the test already had would be a branch the
 * test had not checked.
 */
const POSITIVELY_SKEWED = new GapSample([
  ...Array.from({ length: 990 }, () => wad('0.001')),
  ...Array.from({ length: 2 }, () => wad('-0.08')),
  ...Array.from({ length: 8 }, () => wad('0.08')),
]);

/**
 * A discrete uniform over ±5.9%, whose excess kurtosis is *negative*.
 *
 * The NIG family has `excess kurtosis > 0` for every parameter set — it is a normal variance-mean
 * mixture, so it is always leptokurtic — which makes this sample a refusal rather than a bad fit. The
 * distinction matters: there is no parameter set that would have been better, so refusing is the only
 * honest answer.
 */
const PLATYKURTIC = new GapSample([
  ...Array.from({ length: 59 }, (_, index) => wad(String((index + 1) / 1000))),
  ...Array.from({ length: 59 }, (_, index) => wad(String(-(index + 1) / 1000))),
]);

/** The sample's own skewness and excess kurtosis, computed here rather than taken from the module. */
function standardisedMoments(sample: GapSample): { skewness: Decimal; excess: Decimal } {
  const gaps = sample.gapsWad.map((gap) => d(gap.toString()).div(d(WAD.toString())));
  const count = d(gaps.length);
  let total = d(0);
  for (const gap of gaps) total = total.plus(gap);
  const mean = total.div(count);
  let second = d(0);
  let third = d(0);
  let fourth = d(0);
  for (const gap of gaps) {
    const deviation = gap.minus(mean);
    const square = deviation.times(deviation);
    second = second.plus(square);
    third = third.plus(square.times(deviation));
    fourth = fourth.plus(square.times(square));
  }
  const m2 = second.div(count);
  return {
    skewness: third.div(count).div(m2.sqrt().pow(3)),
    excess: fourth.div(count).div(m2.times(m2)).minus(3),
  };
}

describe('the NIG fit', () => {
  it('recovers the shape invariants of the leptokurtic sample', () => {
    // Pinned to 25 significant digits. The inversion is closed-form arithmetic — no quadrature is
    // involved — so these are stable against any change to the integration below, and a drift here
    // means the algebra moved rather than the numerics.
    const fitted = nigParameters(LEPTOKURTIC);
    expect(sig(fitted.alpha, 25)).toBe('22.00554538076734953335217');
    expect(sig(fitted.beta, 25)).toBe('-0.4791246656485017730967348');
    expect(sig(fitted.delta, 25)).toBe('0.00140757125719623610612914');
    expect(sig(fitted.mu, 25)).toBe('0.001020654183139008088653407');
    expect(sig(fitted.shape, 25)).toBe('0.03096703045980250714311244');
  });

  it('derives gamma from the parameters rather than trusting the caller', () => {
    const fitted = nigParameters(LEPTOKURTIC);
    // `|beta| < alpha` is exactly `gamma > 0`, so this is the constraint the constructor exists to
    // make checkable rather than assumed.
    expect(fitted.gamma.gt(0)).toBe(true);
    expect(
      fitted.gamma
        .times(fitted.gamma)
        .minus(fitted.alpha.times(fitted.alpha))
        .plus(fitted.beta.times(fitted.beta))
        .abs()
        .lt('1e-40'),
    ).toBe(true);
    expect(fitted.shape.toString()).toBe(fitted.delta.times(fitted.gamma).toString());
  });

  it('reproduces the sample skewness and excess kurtosis', () => {
    // The tracker's own wording for G0, and the check that makes the inversion meaningful: the fitted
    // parameters must reproduce the two standardised moments they were inverted from. The NIG's
    // standardised moments are `3*rho/sqrt(shape)` and `3*(1 + 4*rho^2)/shape`, written out here.
    const fitted = nigParameters(LEPTOKURTIC);
    const wanted = standardisedMoments(LEPTOKURTIC);
    const rho = fitted.beta.div(fitted.alpha);
    const reproducedSkewness = d(3).times(rho).div(fitted.shape.sqrt());
    const reproducedExcess = d(3)
      .times(d(1).plus(rho.times(rho).times(4)))
      .div(fitted.shape);
    expect(reproducedSkewness.minus(wanted.skewness).abs().lt('1e-40')).toBe(true);
    expect(reproducedExcess.minus(wanted.excess).abs().lt('1e-40')).toBe(true);
    // and the sample really is the shape the fixture claims, so the two assertions above are not
    // checking a fit against a mis-stated input.
    expect(sig(wanted.skewness, 25)).toBe('-0.3711828198745074216043479');
    expect(sig(wanted.excess, 25)).toBe('97.060927976334677181766');
  });

  it('gives a positively skewed sample a positive beta', () => {
    // The sign branch. `rho = sign(skewness) * sqrt(rho^2)`, and a sample with a symmetric or negative
    // tail never reaches the other side of it.
    const fitted = nigParameters(POSITIVELY_SKEWED);
    expect(fitted.beta.gt(0)).toBe(true);
    expect(fitted.alpha.gt(0)).toBe(true);
    const wanted = standardisedMoments(POSITIVELY_SKEWED);
    expect(wanted.skewness.gt(0)).toBe(true);
  });

  it('shifts mu with the sample and leaves the shape alone', () => {
    // Exact, not approximate: NIG is a location-scale family, so the central moments are shift
    // invariant and only `mu` moves. This is what pins the `mu = m1 - delta*beta/gamma` line — an
    // inversion that dropped `mu` entirely, or took the raw mean for it, would pass every other test
    // here, because every other fixture has a mean small enough to hide behind the tolerance.
    const shift = wad('0.05');
    const base = nigParameters(LEPTOKURTIC);
    const moved = nigParameters(new GapSample(LEPTOKURTIC.gapsWad.map((gap) => gap + shift)));
    expect(moved.alpha.toString()).toBe(base.alpha.toString());
    expect(moved.beta.toString()).toBe(base.beta.toString());
    expect(moved.delta.toString()).toBe(base.delta.toString());
    expect(moved.mu.minus(base.mu).toString()).toBe(d('0.05').toString());
  });

  it('refuses a sample with no variance', () => {
    const flat = new GapSample(Array.from({ length: 5 }, () => wad('0.01')));
    expect(() => nigParameters(flat)).toThrow(/needs a sample with a variance/);
  });

  it('refuses a platykurtic sample, because no parameter set would fit it', () => {
    // Not a bad fit — no fit. Every NIG is leptokurtic, so a sample with negative excess kurtosis is
    // outside the family entirely, and the message says which inequality failed rather than reporting
    // a failure of the algorithm.
    expect(() => nigParameters(PLATYKURTIC)).toThrow(/outside the NIG family/);
    expect(() => nigParameters(PLATYKURTIC)).toThrow(
      /3\*excess kurtosis - 4\*skewness\^2 is -3\.64/,
    );
  });

  it('refuses a sample whose shape puts beta at or above alpha', () => {
    // The second cone condition, and it is reachable: this sample's standardised moments give
    // `rho^2 = 1.637`. Found by search rather than constructed — a random small sample lands in the
    // band `(4/3)*skewness^2 < excess <= (5/3)*skewness^2` about once in 20,000 tries.
    const narrow = new GapSample([wad('0.005'), wad('-0.007'), 0n, 0n, 0n, 0n, 0n]);
    expect(() => nigParameters(narrow)).toThrow(/at or above alpha/);
    expect(() => nigParameters(narrow)).toThrow(/rho\^2 is 1\.6370850615/);
  });
});

describe('the non-central truncated normal moment', () => {
  it('agrees with moments.ts at a zero mean', () => {
    // Measured worst case over these pairs: 1.79e-49 relative, which is the last digit of the
    // fifty-digit working precision. The two are the same quantity by different algebraic routes — this
    // one takes three `Phi` differences where the sibling takes one — so the reduction is algebraic
    // and not bit-exact, and the bar below is that measurement with three decades of room.
    let worst = d(0);
    // `as const`, because `noUncheckedIndexedAccess` makes an un-annotated destructuring of an array
    // literal give `string | undefined` for each element.
    for (const [cap, scale] of [
      ['0.0001', '0.02'],
      ['0.001', '0.02'],
      ['0.05', '0.02'],
      ['1', '0.3'],
      ['50', '7'],
    ] as const) {
      const got = truncatedAbsMomentForNormal(d(cap), d(0), d(scale));
      const want = truncatedAbsMomentAtCap(d(cap), d(scale));
      const relative = got.minus(want).abs().div(want);
      if (relative.gt(worst)) worst = relative;
      expect(relative.lt('1e-45'), `cap=${cap} scale=${scale}`).toBe(true);
    }
    // and the worst case is not merely under the bar but is the last-digit difference the docstring
    // claims, so a future change that widened it would be visible here rather than at the bar.
    expect(worst.lt('1e-48')).toBe(true);
    expect(worst.gt(0)).toBe(true);
  });

  it('reaches the folded-normal mean as the cap grows', () => {
    // The `cap -> infinity` limit, in closed form: `E[|X|]` for `X ~ N(mean, scale^2)` is
    // `scale*sqrt(2/pi)*exp(-mean^2/(2*scale^2)) + mean*(1 - 2*Phi(-mean/scale))`. Exact here rather
    // than approximate, because at this cap the three tail terms are below working precision and the
    // truncation is not a truncation at all.
    const mean = d('0.013');
    const scale = d('0.021');
    const folded = scale
      .times(d('0.7978845608028653558798921198687637369517172623298693153318522425059570375383161'))
      .times(mean.times(mean).div(scale.times(scale).times(2)).neg().exp())
      .plus(mean.times(d(1).minus(standardNormalCdf(mean.neg().div(scale)).times(2))));
    const got = truncatedAbsMomentForNormal(d(1000), mean, scale);
    expect(got.toString()).toBe(folded.toString());
  });

  it('reaches the untruncated absolute mean at a zero mean', () => {
    // The other corner: a zero mean and an infinite cap is `scale*sqrt(2/pi)`, which is the same limit
    // `moments.ts` documents for its own primitive.
    const scale = d('0.02');
    const got = truncatedAbsMomentForNormal(d(1000), d(0), scale);
    const wanted = scale.times(
      d('0.7978845608028653558798921198687637369517172623298693153318522425059570375383161'),
    );
    expect(got.minus(wanted).abs().div(wanted).lt('1e-45')).toBe(true);
  });
});

/**
 * Consecutive pairs of a list.
 *
 * `noUncheckedIndexedAccess` makes every `list[index]` a `T | undefined`, and the project's answer
 * elsewhere is to refuse the read rather than assert it — see `at()` above. Zipping sidesteps the
 * question instead of answering it, which is the right trade here because the index is not what any of
 * these tests is about.
 */
function consecutive<T>(values: readonly T[]): readonly (readonly [T, T])[] {
  const pairs: (readonly [T, T])[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) {
      throw new Error(`a list of ${String(values.length)} has no pair at ${String(index)}`);
    }
    pairs.push([previous, current]);
  }
  return pairs;
}

/** The `index`th element, refusing an out-of-range read rather than returning `undefined`. */
function element<T>(values: readonly T[], index: number): T {
  const found = values[index];
  if (found === undefined) {
    throw new Error(`index ${String(index)} is outside a list of ${String(values.length)}`);
  }
  return found;
}

describe('the quadrature plan', () => {
  it('floors the point count', () => {
    // The floor is what carries the large-shape end, where `acosh` stops shrinking and the ratio stops
    // binding. Measured: at a 1e-22 bar the minimum for shape 3.16 is 64 and for shape 1e3 is 56, so
    // the floor is the binding rule for everything above 3.16.
    expect(nigQuadraturePlan(d('3.16')).points).toBe(64);
    expect(nigQuadraturePlan(d('1e3')).points).toBe(64);
    expect(nigQuadraturePlan(d('1e12')).points).toBe(64);
  });

  it('spends more nodes as the shape shrinks', () => {
    // Monotone non-increasing, which is the property the rule is derived from: a smaller shape is a
    // narrower integrand on a range that shrinks only logarithmically. The shape travels with the count
    // so that a failure names the pair rather than the position.
    const plan = ['0.0001', '0.001', '0.01', '0.1', '1', '3.16', '10', '1e3'].map(
      (shape) => [shape, nigQuadraturePlan(d(shape)).points] as const,
    );
    for (const [previous, current] of consecutive(plan)) {
      expect(current[1], `${previous[0]} -> ${current[0]}`).toBeLessThanOrEqual(previous[1]);
    }
    expect(element(plan, 0)[1]).toBeGreaterThan(element(plan, plan.length - 1)[1]);
  });

  it('sends the range to sqrt(2*DECAY)', () => {
    // The one property here that is not a measurement. As `shape` grows, `acosh(1 + DECAY/shape)`
    // tends to `sqrt(2*DECAY/shape)`, so `tMax` tends to `sqrt(2*DECAY)` = 17.3205…. A range that kept
    // growing would mean the substitution had been inverted somewhere.
    //
    // The approach is not asserted at a fixed bar, because it is only first order. Expanding
    // `acosh(1 + eps) = sqrt(2*eps)*(1 - eps/12 + ...)` with `eps = DECAY/shape` gives
    // `sqrt(2*DECAY) - tMax = sqrt(2*DECAY)*DECAY/(12*shape)`, so the *relative* gap times `shape`
    // tends to `DECAY/12` = 12.5. That is the assertion: a coefficient rather than a tolerance, and one
    // that would fail if `DECAY` were changed without re-measuring the node counts that depend on it.
    const limit = d(300).sqrt();
    const coefficient = d(150).div(12);
    for (const shape of ['1e9', '1e12']) {
      const range = nigQuadraturePlan(d(shape)).tMax;
      expect(range.lt(limit)).toBe(true);
      const scaled = limit.minus(range).div(limit).times(d(shape));
      expect(
        scaled.minus(coefficient).abs().div(coefficient).lt('1e-3'),
        `shape=${shape} scaled gap ${scaled.toString()}`,
      ).toBe(true);
    }
    expect(nigQuadraturePlan(d('1e3')).tMax.lt(nigQuadraturePlan(d('1e12')).tMax)).toBe(true);
  });

  it('grows the range with the shape', () => {
    const ranges = ['0.0001', '0.001', '0.01', '0.1', '1', '10', '1e3'].map(
      (shape) => [shape, nigQuadraturePlan(d(shape)).tMax] as const,
    );
    for (const [previous, current] of consecutive(ranges)) {
      expect(current[1].gt(previous[1]), current[0]).toBe(true);
    }
  });
});

describe('the mixture quadrature', () => {
  it('converges to the Gaussian moment at rate 1/delta', () => {
    // With `beta = 0` and `alpha = gamma = delta/sigma^2`, the marginal variance is `delta/gamma`, so
    // holding it at `sigma^2` and growing `delta` walks the NIG towards a normal. The measured error
    // falls by a factor of 100 for every factor of 100 in `delta` — `1/delta`, the rate the expansion
    // predicts — and asserting the *rate* is what makes this a check on the quadrature rather than on
    // three numbers that happen to be small.
    const sigma = d('0.02');
    const cap = d('0.05');
    const gaussian = truncatedAbsMomentAtCap(cap, sigma);
    const relativeErrors = ['4', '40', '400'].map((deltaText) => {
      const delta = d(deltaText);
      const gamma = delta.div(sigma.times(sigma));
      const params = new NigParameters({ alpha: gamma, beta: d(0), delta, mu: d(0) });
      // the variance really is held fixed, so the limit being approached is the one asserted
      expect(params.shape.div(gamma.times(gamma)).toString()).toBe(sigma.times(sigma).toString());
      return nigTruncatedAbsMomentAtCap(params, cap).minus(gaussian).abs().div(gaussian);
    });
    expect(element(relativeErrors, 0).lt('1e-5')).toBe(true);
    for (const [previous, current] of consecutive(relativeErrors)) {
      const ratio = previous.div(current);
      expect(ratio.minus(100).abs().div(100).lt('1e-3'), `ratio ${ratio.toString()}`).toBe(true);
    }
  });

  it('refuses a non-positive cap', () => {
    const params = nigParameters(LEPTOKURTIC);
    expect(() => nigTruncatedAbsMomentAtCap(params, d(0))).toThrow(/cap must be positive/);
    expect(() => nigTruncatedAbsMomentAtCap(params, d('-1'))).toThrow(/cap must be positive/);
  });
});

describe('the NIG family', () => {
  it('is not the seed and declares its own name', () => {
    const family = at('nig');
    expect(family).toBeInstanceOf(NigFamily);
    expect(family.name).toBe('nig');
    expect(family.isSeedModel).toBe(false);
  });

  it('beats the Gaussian on a leptokurtic sample, at every leverage', () => {
    // Tracker G0's acceptance, and the same shape of assertion `families.test.ts` makes for the
    // Gaussian's rejection. Table 18's ranking is NIG closer than Gaussian; the magnitudes here are far
    // larger than the paper's because the fixture is a two-point construction, which is stated in the
    // file header rather than papered over.
    for (const lam of [11n, 32n]) {
      const lamWad = lam * WAD;
      const empirical = at('empirical').premiumWad(lamWad, LEPTOKURTIC);
      const gaussian = relativeErrorWad(at('gaussian').premiumWad(lamWad, LEPTOKURTIC), empirical);
      const nig = relativeErrorWad(at('nig').premiumWad(lamWad, LEPTOKURTIC), empirical);
      expect(nig, `lam=${lam.toString()}`).toBeGreaterThan(0n);
      expect(gaussian, `lam=${lam.toString()}`).toBeGreaterThan(0n);
      expect(nig < gaussian, `lam=${lam.toString()}`).toBe(true);
      // and the two are not merely ordered but separated by more than a factor of two, so the
      // assertion is not satisfied by a rounding difference.
      expect(nig * 2n < gaussian, `lam=${lam.toString()}`).toBe(true);
    }
  });

  it('refuses a non-positive leverage rather than inventing an infinite cap', () => {
    // A documented departure from `GaussianFamily`, which reads `lam == 0` as an infinite cap and can,
    // because the folded normal has a closed form. The folded NIG mean is a different integral with no
    // closed form in the parameters, so this family declines.
    expect(() => at('nig').premiumWad(0n, LEPTOKURTIC)).toThrow(/positive leverage/);
    expect(() => at('nig').premiumWad(-WAD, LEPTOKURTIC)).toThrow(/positive leverage/);
  });

  it('refuses a sample outside the family rather than mis-fitting it', () => {
    // The refusal has to reach the caller through the family interface, not only through
    // `nigParameters` — a family that silently produced a number for a sample it cannot describe would
    // be worse than one that is missing.
    expect(() => at('nig').premiumWad(15n * WAD, PLATYKURTIC)).toThrow(/outside the NIG family/);
  });

  it('carries the family name and the observation count', () => {
    const fit = at('nig').fit(15n * WAD, LEPTOKURTIC);
    expect(fit.family).toBe('nig');
    expect(fit.observations).toBe(1000);
    expect(fit.lamWad).toBe(15n * WAD);
    // `premiumPerUnitWad` is what the registry publishes, and it must be the fit's own premium.
    expect(fit.premiumPerUnitWad).toBe(fit.premiumWad);
  });
});
