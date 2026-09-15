/**
 * The normal-inverse-Gaussian family: the thin-sample fallback.
 *
 * Paper §5.3 and Table 31 P0 name the empirical truncated distribution as the seed and the NIG as the
 * fallback for a window too short to place the cap. Table 18 is why it is worth having: its premium
 * error against the empirical distribution runs −1.1% to +2.4%, against the Gaussian's +29% to +42%.
 * F10 is closed — NIG is a fallback, not the production model — and a fallback that does not exist is
 * not a fallback, which is tracker G0.
 *
 * **The modified Bessel function is not needed, and that is the finding this module records.** Both
 * tracker G0 and `DESIGN_NOTES.md` F39 assume the NIG requires `K_1`, a numerical routine that would
 * have to live in an adapter rather than in `domain/`. It does not, because the marginal density is
 * never formed. Written as a normal variance-mean mixture — `G | V ~ N(mu + beta*V, V)` with
 * `V ~ IG(delta/gamma, delta^2)`, `gamma = sqrt(alpha^2 - beta^2)` — the truncated absolute moment is
 * a one-dimensional integral of an elementary function against an elementary mixing density:
 *
 *     E[min(|G|, c)] = (1/sqrt(2 pi)) * integral exp(shape - s/2 - shape*cosh s)
 *                                                * M(c, mu + beta*v0*exp(s), sqrt(v0*exp(s))) ds
 *
 * with `v0 = delta/gamma`, `shape = delta*gamma`, and `M` the non-central truncated absolute normal
 * moment below. No Bessel function appears, so F39's placement rule is not exercised by this family.
 * That is stated rather than left implicit, because a rule that looks violated and is not is a rule
 * the next reader will re-derive.
 *
 * **The fit is by method of moments, in closed form.** Paper §7.11 fits by maximum likelihood and
 * records that MLE understates the variance by 2–6% on short windows — which is precisely the regime
 * this family exists for. The inversion below is exact and non-iterative: the two standardised sample
 * moments give the shape invariants `rho = beta/alpha` and `shape = delta*gamma` in one step each, and
 * the scale then follows from the variance. What it costs is conditioning — the fourth moment of a
 * thin sample is a noisy statistic, and the family refuses rather than approximates when the sample's
 * `(skewness, kurtosis)` pair falls outside the NIG cone. Recorded as F87.
 *
 * **The quadrature's range and point count are measured, not chosen.** `shape` sets both, because the
 * integrand's width in the integration variable is `sqrt(shape)` while the range grows only
 * logarithmically — so the node count that reaches working precision is `12 * acosh(1 + 150/shape)`,
 * floored at 64. Measured over `shape` from 1e-4 to 1e3 the worst mass error is 7.3e-26, four orders
 * below the 1e-22 that `toWad`'s 1e-18 grid needs. See `nigQuadraturePlan`.
 *
 * **No `Math`.** The point count is rounded with `Decimal.ceil` and clamped with a comparison, because
 * the domain bans `Math` and "it is only a loop bound" is not an exemption the eslint rule knows about.
 */

import { type Decimal } from 'decimal.js';

import { D, SQRT_TWO_PI, standardNormalCdf, standardNormalPdf } from '../moments.js';
import {
  type DistributionFamily,
  FamilyError,
  FamilyFit,
  type GapSample,
  premiumFromTruncatedMean,
} from './base.js';
import { dimensionless, toWad } from './gaussian.js';

/** Shorthand for a `D`-precision decimal, so the arithmetic below reads as arithmetic. */
const d = (value: Decimal.Value): Decimal => new D(value);

/**
 * How far below working precision the mixing weight may fall at the ends of the integration range.
 *
 * The range is where `shape * (cosh s - 1)` reaches this, so the endpoint weight is `exp(-150)`, or
 * 1e-65 at fifty digits. The value is not tight and is not meant to be: the range enters the node
 * count only through `acosh`, which is logarithmic, so halving this buys about 4% of the nodes and
 * costs two decades of headroom.
 */
const DECAY = d(150);

/**
 * Nodes per unit of `acosh(1 + DECAY/shape)`, and the floor under it.
 *
 * Both measured. The floor is what carries the large-`shape` end, where the range stops shrinking and
 * the ratio stops being the binding constraint; 64 covers every `shape` above 3.16 at the stated bar.
 */
const POINTS_PER_ACOSH = d(12);
const MIN_POINTS = 64;
/** `MIN_POINTS` as the decimal the comparison needs. Derived, never written down a second time. */
const MIN_POINTS_DECIMAL = d(MIN_POINTS);

/** The two trapezoid weights. The end nodes carry half. */
const HALF = d('0.5');
const ONE = d(1);

/**
 * A fitted NIG parameter set, in the paper's `(alpha, beta, delta, mu)` convention.
 *
 * `gamma` is derived at construction rather than stored by the caller, because every consumer needs it
 * and `sqrt(alpha^2 - beta^2)` is the one place the four parameters are constrained: `|beta| < alpha`
 * is exactly `gamma > 0`.
 */
export class NigParameters {
  readonly alpha: Decimal;
  readonly beta: Decimal;
  readonly delta: Decimal;
  readonly mu: Decimal;
  readonly gamma: Decimal;

  constructor(fields: { alpha: Decimal; beta: Decimal; delta: Decimal; mu: Decimal }) {
    this.alpha = fields.alpha;
    this.beta = fields.beta;
    this.delta = fields.delta;
    this.mu = fields.mu;
    this.gamma = fields.alpha.times(fields.alpha).minus(fields.beta.times(fields.beta)).sqrt();
  }

  /** `delta * gamma`, the shape invariant both the range and the point count read. */
  get shape(): Decimal {
    return this.delta.times(this.gamma);
  }
}

/**
 * The method-of-moments fit, in closed form.
 *
 * With `s` the sample skewness, `k` its excess kurtosis, `rho = beta/alpha` and `shape = delta*gamma`,
 * the NIG's standardised moments are `s = 3*rho/sqrt(shape)` and `k = 3(1 + 4*rho^2)/shape`. Two
 * equations, two unknowns, and they eliminate without a quadratic:
 *
 *     rho^2 = s^2 / (3k - 4s^2)          shape = 9 / (3k - 4s^2)
 *
 * The scale then follows from the variance, `m2 = shape / (gamma^2 (1 - rho^2))`, and `mu` from the
 * mean, `m1 = mu + delta*beta/gamma`.
 *
 * Round-tripped against the exact cumulants of known parameter sets at fifty digits: recovered to
 * between 1e-47 and 1e-50 across eight sets spanning `rho` from −0.96 to +0.97 and `shape` from 0.23
 * to 65. Three of those sets are refused by the cone conditions below, and the refusals are the point
 * — see the class docstring's note on conditioning.
 *
 * The three refusals are domain results, not programmer errors, and they are why the fallback can
 * decline a sample: a window whose standardised shape lies outside the family is a window the family
 * cannot describe, and saying so is more useful than a fitted set that reproduces the mean and the
 * variance while missing the tail the payoff reads.
 */
export function nigParameters(sample: GapSample): NigParameters {
  const gaps = sample.gapsWad.map((gap) => dimensionless(gap));
  const count = d(sample.count);

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
  const m3 = third.div(count);
  const m4 = fourth.div(count);

  // The population form, dividing by `n` rather than `n - 1`, for the reason `GapSample.sigmaWad`
  // gives: the window is the whole of what is known rather than a draw from a larger population.
  // Unlike `sigmaWad` nothing is truncated here — the inversion is nonlinear, so quantising its input
  // to the WAD grid would move all four parameters by far more than the wei it saved.
  if (m2.isZero()) {
    throw new FamilyError(
      'a NIG fit needs a sample with a variance; every observation is identical',
    );
  }

  const skewness = m3.div(m2.sqrt().pow(3));
  const excess = m4.div(m2.times(m2)).minus(3);
  const denominator = excess.times(3).minus(skewness.times(skewness).times(4));
  if (!denominator.gt(0)) {
    throw new FamilyError(
      `the sample's standardised shape is outside the NIG family: 3*excess kurtosis - 4*skewness^2 ` +
        `is ${denominator.toString()}, and the family needs it positive`,
    );
  }

  const rhoSquared = skewness.times(skewness).div(denominator);
  if (!rhoSquared.lt(1)) {
    throw new FamilyError(
      `the sample's standardised shape puts |beta| at or above alpha: rho^2 is ` +
        rhoSquared.toString(),
    );
  }

  const shape = d(9).div(denominator);
  const complement = d(1).minus(rhoSquared);
  const rho = skewness.isNegative() ? rhoSquared.sqrt().neg() : rhoSquared.sqrt();
  const gamma = shape.div(complement.times(m2)).sqrt();
  const alpha = gamma.div(complement.sqrt());
  const beta = rho.times(alpha);
  const delta = shape.div(gamma);
  return new NigParameters({ alpha, beta, delta, mu: mean.minus(delta.times(beta).div(gamma)) });
}

/**
 * The integration range and the node count for a given shape invariant.
 *
 * The mixing variable is substituted as `v = v0 * exp(s)` and then `s = t / sqrt(shape)`, which turns
 * the exponent into `shape - s/2 - shape*cosh s`. Its two terms pull in opposite directions: near the
 * origin it is `-t^2/2 - t/(2 sqrt(shape))`, a Gaussian of unit width in `t` regardless of `shape`,
 * while at the ends `shape*cosh(s)` dominates and decays double-exponentially. So the *width* of the
 * integrand scales with `sqrt(shape)` and the range does not, which is why the node count is a
 * multiple of `acosh` rather than of the range itself.
 *
 * Exported because the rule is measured and a measurement that cannot be re-run is a claim: the test
 * asserts the floor, the monotonicity, and the accuracy at the point counts it returns.
 *
 * The range has a closed-form limit worth pinning, because it is the one thing here that does not
 * depend on a measurement: as `shape` grows without bound `acosh(1 + DECAY/shape)` tends to
 * `sqrt(2*DECAY/shape)`, so `tMax` tends to `sqrt(2*DECAY)` — 17.320508075689, reached to nine digits
 * by `shape = 1e9`. A range that kept growing would be a sign the substitution had been inverted.
 */
export function nigQuadraturePlan(shape: Decimal): { tMax: Decimal; points: number } {
  const argument = d(1).plus(DECAY.div(shape));
  const acosh = argument.plus(argument.times(argument).minus(1).sqrt()).ln();
  const raw = POINTS_PER_ACOSH.times(acosh).ceil();
  return {
    tMax: shape.sqrt().times(acosh),
    points: raw.lt(MIN_POINTS_DECIMAL) ? MIN_POINTS : raw.toNumber(),
  };
}

/**
 * `E[ min(|X|, cap) ]` for `X ~ N(mean, scale^2)`, with the mean free.
 *
 * The one primitive `moments.ts` cannot supply, because `truncatedAbsMoment` refuses a non-zero mean
 * and is right to: `|X|` is then folded normal and the closed form it implements does not apply. Here
 * the mean is not free by accident — it is `mu + beta*v` at each quadrature node, and a NIG with a
 * skewed fit has `mu` non-zero.
 *
 * Split at `|X| = cap` and at the sign change, with `G(x) = mean*Phi(u) - scale*phi(u)` the
 * antiderivative of `x*f(x)`, `u = (x - mean)/scale`:
 *
 *     M = mean*(Phi(u_c) - 2*Phi(u_0) + Phi(u_m)) - scale*(phi(u_c) - 2*phi(u_0) + phi(u_m))
 *         + cap*(1 - Phi(u_c) + Phi(u_m))
 *
 * where `u_c = (cap - mean)/scale`, `u_0 = -mean/scale`, `u_m = (-cap - mean)/scale`.
 *
 * **It reduces to `moments.ts`'s primitive at a zero mean**, term by term: the first bracket becomes
 * `Phi(u_c) - 1 + Phi(-u_c) = 0`, the second becomes `2*(phi(u_c) - phi(0))`, and the third becomes
 * `2*cap*(1 - Phi(u_c))` — which is `truncatedAbsMomentAtCap` written out.
 *
 * The reduction is algebraic, not bit-exact, and the difference is worth stating because the two are
 * easy to mistake for the same computation. They reach the same quantity by different routes — this
 * one takes three `Phi` differences where the sibling takes one, and `Phi(u_c) - 1 + Phi(-u_c)` is
 * `0` only in exact arithmetic. Measured over 88 `(cap, scale)` pairs the worst relative difference is
 * 1.79e-49, which is the last digit of the fifty-digit working precision; the two agree to 48 digits
 * in every case. The test therefore asserts a tolerance of 1e-45 rather than equality, and the
 * tolerance is this measurement rather than a round number.
 *
 * It lives here rather than beside its sibling in `moments.ts` because that module's docstring claims
 * it "computes the same identities as `contracts/src/libraries/Stat.sol`", and this one has no
 * Solidity counterpart. Adding it there would make that claim false in the quiet direction.
 */
export function truncatedAbsMomentForNormal(cap: Decimal, mean: Decimal, scale: Decimal): Decimal {
  const upper = cap.minus(mean).div(scale);
  const origin = mean.neg().div(scale);
  const lower = cap.neg().minus(mean).div(scale);

  const body = mean
    .times(
      standardNormalCdf(upper)
        .minus(standardNormalCdf(origin).times(2))
        .plus(standardNormalCdf(lower)),
    )
    .minus(
      scale.times(
        standardNormalPdf(upper)
          .minus(standardNormalPdf(origin).times(2))
          .plus(standardNormalPdf(lower)),
      ),
    );
  const tail = cap.times(d(1).minus(standardNormalCdf(upper)).plus(standardNormalCdf(lower)));
  return body.plus(tail);
}

/**
 * `E[ min(|G|, cap) ]` for a fitted NIG, by the mixture quadrature described in the module header.
 *
 * Note the guard's absence: the reconnaissance skipped a node whose weight was exactly zero, because
 * the substitution `v = v0 * exp(s)` feeds `sqrt(v)` into the inner moment and a zero weight times a
 * zero scale is a `NaN`. With the range derived from `DECAY` the endpoint weight is `exp(-150)` —
 * representable at fifty digits, and never zero — so the guard cannot fire and is not written. A
 * branch that cannot be reached is a branch that cannot be tested, and the coverage rule would have
 * made it a hint instead.
 */
export function nigTruncatedAbsMomentAtCap(params: NigParameters, cap: Decimal): Decimal {
  if (!cap.gt(0)) {
    throw new FamilyError('a truncation cap must be positive');
  }
  const shape = params.shape;
  const root = shape.sqrt();
  const v0 = params.delta.div(params.gamma);
  const { tMax, points } = nigQuadraturePlan(shape);
  const step = tMax.times(2).div(points);

  let total = d(0);
  for (let index = 0; index <= points; index += 1) {
    const t = tMax.neg().plus(step.times(index));
    const s = t.div(root);
    const weight = shape.minus(s.div(2)).minus(shape.times(s.cosh())).exp();
    const v = v0.times(s.exp());
    const moment = truncatedAbsMomentForNormal(cap, params.mu.plus(params.beta.times(v)), v.sqrt());
    const end = index === 0 || index === points;
    total = total.plus(weight.times(moment).times(end ? HALF : ONE));
  }
  return total.times(step).div(SQRT_TWO_PI);
}

/**
 * The NIG family.
 *
 * **`premiumWad` refuses a non-positive leverage where `GaussianFamily` accepts zero.** The Gaussian's
 * primitive reads `lam == 0` as an infinite cap and returns the untruncated `E[|G|]`, which it can,
 * because the folded normal has a closed form. The NIG's does not: an infinite cap is not a cap the
 * quadrature can be given, and the folded *NIG* mean is a different integral with no closed form in
 * the parameters. Refusing is the honest answer, and it is the caller's leverage rule — which reads a
 * quantile of a non-degenerate sample — that makes it unreachable in practice.
 */
export class NigFamily implements DistributionFamily {
  readonly name = 'nig';

  /** Not the seed. The seed is the empirical truncated distribution, per §5.3 / Table 31 P0. */
  readonly isSeedModel = false;

  premiumWad(lamWad: bigint, sample: GapSample): bigint {
    const lam = dimensionless(lamWad);
    if (!lam.gt(0)) {
      throw new FamilyError(
        'the NIG moment needs a positive leverage: an infinite cap has no closed form here',
      );
    }
    const params = nigParameters(sample);
    const moment = nigTruncatedAbsMomentAtCap(params, d(1).div(lam));
    return premiumFromTruncatedMean(lamWad, toWad(moment));
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
