/**
 * BELL-IV: the pool price inverted, and the freshness guard around it.
 *
 * **No oracle, and the two kinds of evidence that stand in for one.** The Python never had an
 * inversion module — the deleted `bell_calibrator.domain` package held `moments`, `leverage`,
 * `sessions`, `digest` and the families, and nothing that inverts a price — and the Solidity side
 * cannot have one either, because the inversion is off chain by construction: the moment is on chain
 * and the root-find is not. So there is nothing to diff against, and this file rests on:
 *
 *   1. **The committed fixture as a round-trip corpus.** `spec/fixtures/moments.json` carries the
 *      Python reference's `(lambda, sigma) -> premium` at fifty digits for 112 points. Inverting its
 *      `premiumWad` and recovering its `sigmaWad` is a round trip through a foreign implementation —
 *      the corpus was not produced by the code under test and cannot be edited to agree with it,
 *      which is why this is stronger than a differential against a re-derivation of itself.
 *   2. **The paper's own published measurements, M14 and M15.** Both are consequences of Eq (12)
 *      rather than of any implementation: M15 states the round-trip bound (1.16e-13 relative over 20
 *      combinations) and M14 states a minimum derivative (4.023e-01 over 5 truncation ratios x 400
 *      volatilities).
 *
 * **M14 is identified, not just reproduced, and the identification is a finding.** The published
 * 4.023e-01 is `unitCapMoment(1/2) = 0.402291446000253296692826626067` to four significant figures,
 * which says what it is: the derivative of the moment along a ray where the cap scales with `sigma`,
 * i.e. `g(u)` itself. The derivative that governs the inversion at a *fixed* leverage is a different
 * quantity, `2(phi(0) - phi(u))`, and on the same five-ratio grid its minimum is
 * `0.093753907274266400330531236676` — not 0.4023. Both are pinned below, together with the exact
 * decomposition that relates them, because a reader who checks M14 against this module's arithmetic
 * would otherwise find two different numbers and no explanation. Neither makes the map
 * non-invertible; the check's number is simply not the number its stated purpose needs. See
 * `DESIGN_NOTES.md` F91.
 *
 * **X8 is measured and does not reproduce as stated, in the conservative direction.** The paper says
 * the inversion's elasticity "is unity to within 0.21% while `c/sigma >= 3`". Measured, the
 * elasticity is 1.0265% from unity at `c/sigma = 3`, and 0.21% is not reached until `c/sigma` is
 * `3.492403635244047`. The paper's *practical* gloss survives — "a 1% relative price error produces a
 * 1% relative volatility error" is true at `c/sigma >= 3.008758104335780` — so the discrepancy is in
 * the tolerance rather than in the claim it supports. Both thresholds are pinned.
 *
 * **The tolerances are derived, not fitted.** The fixture round trip is checked against the paper's
 * published 1.16e-13, and the achieved worst is pinned at 3.195e-17 — a factor of 3630 inside it,
 * which is what the difference between a fifty-digit root-find and a twenty-combination check looks
 * like. The bound that *explains* that figure is derived below rather than pinned: the root-find
 * stops when `|h(u) - pL|` reaches one wei, so the ratio error is at most
 * `1e-18 / (pL * |e_h|)`, and the suite checks that inequality at all 112 points (worst 0.637 of it).
 * The elasticity's tolerance is the paper's own 0.21%, and where it fails it fails by a factor of 4.9
 * rather than by a hair, so no rounding choice could explain it away.
 */

import { readFileSync } from 'node:fs';

import { type Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { STALENESS_SESSIONS, WAD } from '../../src/domain/constants.js';
import { toWad } from '../../src/domain/families/gaussian.js';
import {
  capRatioForPrice,
  dimensionlessPrice,
  ImpliedError,
  impliedVolatility,
  publishedVolatility,
  unitCapMoment,
  VolatilityReading,
  volatilitySource,
} from '../../src/domain/implied.js';
import { Wad } from '../../src/domain/models.js';
import {
  D,
  standardNormalCdf,
  standardNormalPdf,
  truncatedAbsMoment,
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

/**
 * The fixture, read once.
 *
 * Once, at module scope, and not inside each test: a second concurrent read of the same path inside
 * one suite reverts intermittently, which `Stat.t.sol` documents on the Solidity side. The committed
 * corpus is the same 112 points the differential suite uses, so it is the *same* file and the same
 * hazard.
 */
const fixture: MomentsFixture = JSON.parse(
  readFileSync(new URL('../../../spec/fixtures/moments.json', import.meta.url), 'utf8'),
) as MomentsFixture;

const WAD_DECIMAL = new D(WAD.toString());
const ONE = new D(1);

/** A decimal literal at `D`'s precision. */
const d = (value: string): Decimal => new D(value);

/** `|a - b| / b` as a `Decimal`, for the round-trip assertions. */
function relativeError(actual: bigint, expected: bigint): Decimal {
  const difference = actual - expected;
  const magnitude = difference < 0n ? -difference : difference;
  return new D(magnitude.toString()).div(new D(expected.toString()));
}

/** A WAD price as the dimensionless `Decimal` the primitives take. */
function priceOf(wadValue: bigint): Decimal {
  return new D(wadValue.toString()).div(WAD_DECIMAL);
}

/**
 * `dE/dsigma` at a **fixed** cap, standardised: `2(phi(0) - phi(u))` with `u = c/sigma`.
 *
 * This is the derivative that governs invertibility at a fixed leverage, because the leverage fixes
 * the cap and the map is `sigma -> lam * E[min(|G|, c)]`. It is also the paper's `truncatedFirstMoment`
 * divided by `sigma`, which is why the module can use that function as its Newton slope — and why
 * confusing it with `unitCapMoment(u)` is so easy: the two are equal at `u -> inf` and differ by a
 * factor of 4.3 at `u = 1/2`.
 */
function fixedCapDerivative(ratio: Decimal): Decimal {
  return standardNormalPdf(d('0')).minus(standardNormalPdf(ratio)).times(2);
}

/** The ratio grid the paper's M14 check names: five truncation ratios. */
const TRUNCATION_RATIOS: readonly Decimal[] = ['0.5', '1', '2', '3', '5'].map(d);

/** `d ln h / d ln u`, the elasticity of the dimensionless price in the truncation ratio. */
function priceElasticity(ratio: Decimal): Decimal {
  const step = ratio.times('1e-25');
  const slope = dimensionlessPrice(ratio.plus(step))
    .minus(dimensionlessPrice(ratio.minus(step)))
    .div(step.times(2));
  return slope.times(ratio).div(dimensionlessPrice(ratio)).abs();
}

/**
 * The inversion's elasticity: `d ln sigma_hat / d ln pL`, which is the reciprocal of the price
 * elasticity because `sigma = 1/(lam*u)` makes `d ln sigma = -d ln u`.
 */
function inversionElasticity(ratio: Decimal): Decimal {
  return ONE.div(priceElasticity(ratio));
}

/** The smallest `c/sigma` at which the inversion's elasticity is within `tolerance` of unity. */
function ratioWhereElasticityIsWithin(tolerance: string): Decimal {
  let below = d('1');
  let above = d('100');
  for (let step = 0; step < 200; step += 1) {
    const middle = below.plus(above).div(2);
    if (inversionElasticity(middle).minus(1).abs().gt(tolerance)) below = middle;
    else above = middle;
  }
  return below.plus(above).div(2);
}

describe('the dimensionless pool price', () => {
  it('is strictly decreasing, so the inversion has exactly one root', () => {
    // Not a spot check: `h'(u) = -2(phi(0) - phi(u))/u^2` is negative for every positive `u`, so the
    // whole sequence must be descending. A single non-descent would mean the module's bisection is
    // bisecting something that is not monotone.
    const ratios = ['0.001', '0.01', '0.1', '0.5', '1', '2', '3', '5', '10', '100', '1000'];
    for (let index = 1; index < ratios.length; index += 1) {
      const previous = dimensionlessPrice(d(ratios[index - 1] ?? '0'));
      const current = dimensionlessPrice(d(ratios[index] ?? '0'));
      expect(previous.gt(current)).toBe(true);
    }
  });

  it('reproduces the pinned values', () => {
    // `h(10)` is pinned at twenty-five digits and is also `sqrt(2/pi)/10` to within 3.75e-26, which
    // is the large-`u` asymptotic `h(u) -> sqrt(2/pi)/u` showing up. The suite asserts the digits
    // and the test below asserts the asymptotic, so a change in the primitive that broke either one
    // would be caught by whichever it broke first.
    expect(dimensionlessPrice(d('0.5')).toFixed(25)).toBe('0.8045828920005065933856533');
    expect(dimensionlessPrice(d('1')).toFixed(25)).toBe('0.6312536196274927591137666');
    expect(dimensionlessPrice(d('2')).toFixed(25)).toBe('0.3904515777846030403899471');
    expect(dimensionlessPrice(d('3')).toFixed(25)).toBe('0.2657067507229233028961994');
    expect(dimensionlessPrice(d('5')).toFixed(25)).toBe('0.1595768907759109358447186');
    expect(dimensionlessPrice(d('10')).toFixed(25)).toBe('0.0797884560802865355879891');
  });

  it('approaches the untruncated absolute mean over the ratio, as Eq (12) says it must', () => {
    // The paper's `c -> infinity` limit, in the ratio's own variable: `h(u) -> E[|Z|]/u`. Checked at
    // two orders of magnitude, because a limit that holds at one point is a coincidence.
    const asymptotic = d('0.7978845608028653558798921');
    for (const ratio of ['10', '100', '1000']) {
      const residual = dimensionlessPrice(d(ratio))
        .minus(asymptotic.div(d(ratio)))
        .abs();
      expect(residual.lt('1e-20')).toBe(true);
    }
  });

  it('refuses a cap ratio that is not positive and finite', () => {
    expect(() => dimensionlessPrice(d('0'))).toThrow(ImpliedError);
    expect(() => dimensionlessPrice(d('-1'))).toThrow(ImpliedError);
    expect(() => dimensionlessPrice(d('NaN'))).toThrow(ImpliedError);
    expect(() => dimensionlessPrice(d('Infinity'))).toThrow(ImpliedError);
    expect(() => unitCapMoment(d('0'))).toThrow(/truncation cap must be positive/);
    expect(() => unitCapMoment(d('-0.5'))).toThrow(/truncation cap must be positive/);
  });
});

describe("the paper's M14 check", () => {
  it('is reproduced exactly as the moment at ratio one half', () => {
    // The published figure is 4.023e-01. This is that number, and the four-figure agreement is what
    // identifies the quantity rather than merely matching it.
    expect(unitCapMoment(d('0.5')).toFixed(30)).toBe('0.402291446000253296692826626067');
  });

  it('is the fixed-ratio derivative, which is not the derivative the inversion needs', () => {
    // The minimum over the ratio grid of `g(u)`, the derivative along a ray where the cap scales with
    // sigma -- which is M14's 4.023e-01 ...
    let fixedRatioMinimum: Decimal | null = null;
    for (const ratio of TRUNCATION_RATIOS) {
      const value = unitCapMoment(ratio);
      if (fixedRatioMinimum === null || value.lt(fixedRatioMinimum)) fixedRatioMinimum = value;
    }
    expect(fixedRatioMinimum?.toFixed(30)).toBe('0.402291446000253296692826626067');

    // ... and the minimum over the same grid of `2(phi(0) - phi(u))`, the derivative at a fixed cap,
    // which is the one that bounds the inversion. 4.3x smaller, and a different number entirely.
    let fixedCapMinimum: Decimal | null = null;
    for (const ratio of TRUNCATION_RATIOS) {
      const value = fixedCapDerivative(ratio);
      if (fixedCapMinimum === null || value.lt(fixedCapMinimum)) fixedCapMinimum = value;
    }
    expect(fixedCapMinimum?.toFixed(30)).toBe('0.093753907274266400330531236676');
  });

  it('relates the two by exactly the tail term, so the gap is not a rounding story', () => {
    // `g(u) = 2(phi(0) - phi(u)) + 2u(1 - Phi(u))`. At u = 1/2 the second term is 0.3085, which is
    // 3.3x the first: the published figure is dominated by the term that has nothing to do with the
    // inversion's conditioning. Asserted as an identity rather than as two pinned numbers.
    for (const ratio of TRUNCATION_RATIOS) {
      const tail = ratio.times(2).times(ONE.minus(standardNormalCdf(ratio)));
      expect(
        unitCapMoment(ratio).minus(fixedCapDerivative(ratio)).minus(tail).abs().lt('1e-45'),
      ).toBe(true);
    }
  });
});

describe('the reachable range', () => {
  it('refuses a price at or above the saturation ceiling', () => {
    // `h(u) < 1` for every `u`, so `pL >= 1` has no solution at all. This is the module's most
    // important guard: without it, bisection would return a large sigma for a price that no
    // volatility can produce, and a caller would publish a number that means nothing.
    expect(() => capRatioForPrice(d('1'))).toThrow(/strictly between 0 and 1/);
    expect(() => capRatioForPrice(d('1.5'))).toThrow(/strictly between 0 and 1/);
    expect(() => impliedVolatility(Wad.one, Wad.one)).toThrow(ImpliedError);
    expect(() => impliedVolatility(Wad.one, Wad.fromWhole(2n))).toThrow(ImpliedError);
  });

  it('refuses a price at or below zero', () => {
    expect(() => capRatioForPrice(d('0'))).toThrow(/strictly between 0 and 1/);
    expect(() => capRatioForPrice(d('-0.5'))).toThrow(/strictly between 0 and 1/);
    expect(() => impliedVolatility(Wad.one, Wad.zero)).toThrow(ImpliedError);
  });

  it('refuses a leverage that would remove the truncation entirely', () => {
    // At `lam = 0` the cap is infinite, the premium is `sigma*sqrt(2/pi)` for every sigma, and the
    // price carries no volatility information. Refusing is the only answer that is not a lie.
    expect(() => impliedVolatility(Wad.zero, Wad.fromStr('0.5'))).toThrow(
      /leverage must be positive/,
    );
    expect(() => impliedVolatility(Wad.fromWhole(-1n), Wad.fromStr('0.5'))).toThrow(
      /leverage must be positive/,
    );
  });

  it('resolves the two ends of the open interval without a search', () => {
    // The closed-form bracket is what makes the extremes cheap: `upper = sqrt(2/pi)/pL` is 7.98e11
    // at a price of 1e-12 and 0.8 at a price of one wei below the ceiling, and neither needs a
    // doubling loop to find. Both terminate, which is the property that matters at the ends.
    expect(capRatioForPrice(d('1e-12')).toExponential(6)).toBe('7.978846e+11');

    // At the upper end the price stops carrying information before the arithmetic does: one wei
    // below the ceiling, *any* ratio up to 5.0e-18 satisfies the stopping rule, so the returned
    // value is pinned to a factor of two rather than to six digits. What is asserted is therefore
    // the contract and not the number -- that the result satisfies the rule it stopped on.
    const nearCeiling = capRatioForPrice(d('0.999999999999999999'));
    expect(nearCeiling.gt(0)).toBe(true);
    expect(nearCeiling.lt('5.1e-18')).toBe(true);
    expect(
      dimensionlessPrice(nearCeiling).minus(d('0.999999999999999999')).abs().lte('1e-18'),
    ).toBe(true);
  });

  it('is limited by the price quantum over the price, and no further', () => {
    // A price of one part in 1e12 carries no information about the ratio below
    // `quantum / (pL * |e_h|) = 1e-6` relative, whatever precision the arithmetic carries: the ratio
    // is `sqrt(2/pi)/pL` to within that, and nothing about the algorithm can improve on the input.
    //
    // The bound is asserted rather than the error, because the error is *inside* it rather than on
    // it -- Newton overshoots the stopping rule instead of stopping on it, and lands at 2.33e-10.
    // Stating the bound as the error would be the kind of over-claim the whole file is written to
    // avoid.
    const measured = capRatioForPrice(d('1e-12'));
    const asymptotic = d('0.7978845608028653558798921').div(d('1e-12'));
    const relative = measured.minus(asymptotic).abs().div(asymptotic);
    expect(relative.lte('1e-6')).toBe(true);
  });
});

describe('the inversion against the committed fixture', () => {
  it('is the corpus it says it is', () => {
    expect(fixture.points.length).toBe(112);
    expect(fixture.points.length).toBe(fixture.pointCount);
  });

  it('recovers every one of the 112 reference volatilities inside the M15 bound', () => {
    // The paper's M15 bound, 1.16e-13 relative, over the whole committed corpus rather than over the
    // twenty combinations the paper used. All 112 recover.
    let worst: Decimal | null = null;
    let overBound = 0;
    for (const point of fixture.points) {
      const recovered = impliedVolatility(
        Wad.fromRaw(BigInt(point.lambdaWad)),
        Wad.fromRaw(BigInt(point.premiumWad)),
      );
      const error = relativeError(recovered.raw, BigInt(point.sigmaWad));
      if (worst === null || error.gt(worst)) worst = error;
      if (error.gt('1.16e-13')) overBound += 1;
    }
    expect(overBound).toBe(0);
    expect(worst?.toExponential(3)).toBe('3.195e-17');
  });

  it('re-prices the recovered volatility back onto the committed price', () => {
    // The other direction, which the M15 round trip does not cover: a sigma that recovers the right
    // sigma but not the right price would pass the assertion above. Worst 467 wei, which is 4.708e-16
    // of the price -- the residue of quantising sigma to the WAD grid before re-pricing.
    let worstWei = 0n;
    for (const point of fixture.points) {
      const lamWad = BigInt(point.lambdaWad);
      const recovered = impliedVolatility(
        Wad.fromRaw(lamWad),
        Wad.fromRaw(BigInt(point.premiumWad)),
      );
      const moment = truncatedAbsMoment(priceOf(lamWad), d('0'), priceOf(recovered.raw));
      const repriced = (lamWad * toWad(moment)) / WAD;
      const difference = repriced - BigInt(point.premiumWad);
      const magnitude = difference < 0n ? -difference : difference;
      if (magnitude > worstWei) worstWei = magnitude;
    }
    expect(worstWei).toBe(467n);
  });

  it('holds the derived accuracy bound at every point, so the error is the input and not the solver', () => {
    // The root-find stops when `|h(u) - pL|` reaches one wei, and `d ln u = -d ln h / e_h`, so the
    // relative error in the ratio -- which is the relative error in sigma -- is at most
    // `1e-18 / (pL * |e_h|)`. Asserted as an inequality at every point rather than pinned as a worst
    // case, because a pinned worst case would pass for an implementation that was accidentally good
    // at 111 points and wrong at one. Measured worst is 0.637 of the bound, and pinned.
    let worstFraction: Decimal | null = null;
    for (const point of fixture.points) {
      const price = priceOf(BigInt(point.premiumWad));
      const ratio = capRatioForPrice(price);
      const bound = d('1e-18').div(price.times(priceElasticity(ratio)));

      const recovered = impliedVolatility(
        Wad.fromRaw(BigInt(point.lambdaWad)),
        Wad.fromRaw(BigInt(point.premiumWad)),
      );
      const error = relativeError(recovered.raw, BigInt(point.sigmaWad));

      const fraction = error.div(bound);
      expect(fraction.lte(1)).toBe(true);
      if (worstFraction === null || fraction.gt(worstFraction)) worstFraction = fraction;
    }
    expect(worstFraction?.toFixed(6)).toBe('0.637287');
  });

  it('inverts the dimensionless price, so the two are inverse to the input granularity', () => {
    // `capRatioForPrice` and `dimensionlessPrice` must be inverses: pricing the recovered ratio must
    // give the price back. This is the property the M15 round trip rests on, asserted at the level
    // where the answer is not also a quantisation of a `Wad` -- and over four orders of magnitude,
    // because an implementation that was only right for prices near one half would pass a single
    // spot check.
    //
    // The residual is the price quantum and not the arithmetic: the root-find stops as soon as
    // `|h(u) - pL|` reaches one wei, so `1e-18` is the floor by construction. The iteration count is
    // deliberately not asserted here. It is a fact about the algorithm rather than about the
    // interface, and the suite catches a regression to plain bisection the honest way -- the fixture
    // block above would take twenty times longer and time out.
    for (const price of ['0.001', '0.01', '0.1', '0.25', '0.5', '0.75', '0.9', '0.99', '0.999']) {
      const value = d(price);
      const residual = dimensionlessPrice(capRatioForPrice(value)).minus(value).abs();
      expect(residual.lte('1e-18')).toBe(true);
    }
  });

  it('agrees with the family layer on the WAD quantisation', () => {
    // The module carries a second copy of `families/gaussian.ts`'s `toWad`, deliberately, so that the
    // pool-price surface does not read as depending on the Gaussian family strategy. A duplicated
    // decision is a drift risk, and this is the assertion that removes it: `capRatioForPrice` is the
    // shared input, so the comparison isolates the quantiser and nothing else.
    for (const point of fixture.points) {
      const lam = Wad.fromRaw(BigInt(point.lambdaWad));
      const price = Wad.fromRaw(BigInt(point.premiumWad));
      const ratio = capRatioForPrice(priceOf(price.raw));
      const fromTheFamilyLayer = toWad(ONE.div(priceOf(lam.raw).times(ratio)));
      expect(impliedVolatility(lam, price).raw).toBe(fromTheFamilyLayer);
    }
  });
});

describe("the inversion's elasticity (check X8)", () => {
  it('is unity to within 1.027% at c/sigma = 3, not the published 0.21%', () => {
    // Measured, and it disagrees with the paper. The paper's stated threshold is where the figure
    // would have to be 0.21% for its own sentence to hold; it is 4.9x that.
    expect(inversionElasticity(d('3')).minus(1).abs().toFixed(20)).toBe('0.01026511282469235685');
  });

  it('reaches 0.21% at c/sigma = 3.492403635244047 and 1.0% at 3.008758104335780', () => {
    // Which is the paper's claim relocated rather than refuted: the sentence that matters --
    // "a 1% relative price error produces a 1% relative volatility error" -- holds from just above
    // the stated threshold, so the discrepancy is in the tolerance and not in the conclusion.
    expect(ratioWhereElasticityIsWithin('0.0021').toFixed(15)).toBe('3.492403635244047');
    expect(ratioWhereElasticityIsWithin('0.01').toFixed(15)).toBe('3.008758104335780');
  });

  it('is the reciprocal of the price elasticity, and approaches unity as the truncation deepens', () => {
    // The relation the two pinned numbers rest on, asserted directly, plus the limit: at `c/sigma = 10`
    // the deviation is below 1e-21, so the inversion is as well conditioned as the price allows.
    for (const ratio of ['3', '5', '10']) {
      const value = d(ratio);
      expect(
        inversionElasticity(value).times(priceElasticity(value)).minus(1).abs().lt('1e-20'),
      ).toBe(true);
    }
    expect(inversionElasticity(d('10')).minus(1).abs().lt('1e-21')).toBe(true);
  });
});

describe('the freshness guard', () => {
  const pool = new VolatilityReading({
    sigmaWad: 260_000_000_000_000_000n,
    session: 100n,
    provenance: 'pool',
  });
  const fallback = new VolatilityReading({
    sigmaWad: 310_000_000_000_000_000n,
    session: 112n,
    provenance: 'trailing-realised',
  });

  it('treats the staleness bound as inclusive, and one session past it as stale', () => {
    // The direction matters and is not arbitrary: Table 19 makes the rotation period equal the
    // staleness bound, so a set at the bound is one the publisher is already due to replace. Reading
    // the bound as exclusive would price on it for one session too many.
    expect(volatilitySource(0n, STALENESS_SESSIONS)).toBe('pool');
    expect(volatilitySource(12n, STALENESS_SESSIONS)).toBe('pool');
    expect(volatilitySource(13n, STALENESS_SESSIONS)).toBe('trailing-realised');
  });

  it('refuses an age or a bound that is negative', () => {
    expect(() => volatilitySource(-1n, STALENESS_SESSIONS)).toThrow(/age cannot be negative/);
    expect(() => volatilitySource(0n, -1n)).toThrow(/bound cannot be negative/);
  });

  it('will not let a frozen pool report its old volatility as current', () => {
    // The whole point of the guard, and the paper's own failure mode: a pool at sigma = 2.60% reports
    // 2.60% for ever. One session past the bound the published reading is the fallback's, and never
    // the pool's value.
    const atTheBound = publishedVolatility(pool, 112n, fallback);
    expect(atTheBound.provenance).toBe('pool');
    expect(atTheBound.sigmaWad).toBe(260_000_000_000_000_000n);

    const past = publishedVolatility(pool, 113n, fallback);
    expect(past.provenance).toBe('trailing-realised');
    expect(past.sigmaWad).toBe(310_000_000_000_000_000n);
    expect(past.sigmaWad).not.toBe(pool.sigmaWad);
  });

  it('refuses rather than pricing on a stale fit when there is no fallback', () => {
    // Table 19's rule for the premium registry, applied to the volatility surface: with nothing to
    // fall back to, the pool refuses. Returning the pool's own reading here is the failure the gate
    // exists to prevent, and returning a boolean would let a caller render the refusal as a number.
    expect(() => publishedVolatility(pool, 113n, null)).toThrow(/refuses to price/);
    // ... and with a bound that still covers the age, the pool's own reading is published, so the
    // refusal above is the bound's doing and not a blanket refusal of a fallback-free call.
    expect(publishedVolatility(pool, 113n, null, 13n).sigmaWad).toBe(260_000_000_000_000_000n);
  });

  it('ages a reading against the session it is about, and refuses a session before it', () => {
    expect(pool.ageAt(100n)).toBe(0n);
    expect(pool.ageAt(112n)).toBe(12n);
    // A reading from the future is a caller error, not a fresh reading. A negative age compared
    // against a bound would read as maximally fresh, which is the direction that fails unsafe.
    expect(() => pool.ageAt(99n)).toThrow(/cannot be aged/);
  });
});
