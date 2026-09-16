/**
 * The distributional primitives, in exact decimal arithmetic.
 *
 * This module is the reference the Solidity implementation is checked against. It computes the same
 * identities as `contracts/src/libraries/Stat.sol`, but with a high-precision error function rather
 * than the on-chain rational approximation, so the difference between the two is the on-chain
 * approximation's error and nothing else. That is what makes the differential tolerance derivable
 * rather than chosen.
 *
 * Pure: no I/O, no clock, no global state. `Decimal` throughout — no `number` appears in any
 * signature, and none appears in any body: the error function is a Taylor series for small arguments
 * and a continued fraction for large ones, both evaluated in `Decimal`.
 *
 * **This is the one module in the port that needs a dependency**, and the reason is measured rather
 * than assumed. It needs 50 significant digits with `exp` and `sqrt`; Node's `number` is an IEEE-754
 * double carrying about 15, and `BigInt` is integer-only. `decimal.js` is the single entry on the
 * domain's allow-list, ruled in DESIGN_NOTES.md R5.1. Every other domain module computes in `bigint`.
 *
 * **The named import, not the default one.** `decimal.js`'s typings offer both, and under
 * `moduleResolution: NodeNext` the default import binds the *module namespace* rather than the class
 * — so `Decimal.clone` and `Decimal.Value` are reported as missing. The named import gives the class,
 * and it resolves at runtime as well because the CommonJS entry sets `module.exports.Decimal`
 * alongside `module.exports` itself. Verified both ways rather than assumed.
 *
 * `Decimal.clone` rather than `Decimal.set`: a clone is a *separate constructor* carrying its own
 * precision, so this module's 50 digits cannot leak into another module's arithmetic and no other
 * module's configuration can silently lower this one's. `Decimal.set` would be a mutable global,
 * which the domain may not have.
 */

import { Decimal } from 'decimal.js';

/** Working precision. */
export const WORKING_PRECISION = 50;

/**
 * The domain's decimal constructor: 50 significant digits, and nothing else changed.
 *
 * Every value in this module is constructed through `D`, so the precision is a property of the
 * module rather than of an ambient setting.
 */
export const D = Decimal.clone({ precision: WORKING_PRECISION });

/** Shorthand for a `D`-precision decimal, so the arithmetic below reads as arithmetic. */
const d = (value: Decimal.Value): Decimal => new D(value);

/**
 * Constants, written as literals rather than computed.
 *
 * `2 / sqrt(pi)` evaluated at module scope would be computed in whatever precision the ambient
 * constructor carried, and the resulting constant would silently cap every downstream result at that
 * width. The Python reference states the same reason for the same literals.
 */

export const SQRT_PI = d('1.77245385090551602729816748334114518279754945612238712821380779');
export const SQRT_TWO = d('1.41421356237309504880168872420969807856967187537694807317667974');
export const SQRT_TWO_PI = d('2.50662827463100050241576528481104525300698674060993831662992358');

/**
 * `2 / sqrt(pi)`, the Maclaurin coefficient, = 1.1283791670955125738961589031215451716759765605253.
 *
 * Not to be confused with `SQRT_TWO_OVER_PI`, which is `sqrt(2 / pi)` = 0.7978845608028653558798921.
 * The two differ by a factor of pi/2 and both appear in this domain — the first as the error
 * function's coefficient, the second as `E[|Z|]`, the untruncated absolute mean. The test
 * `constants are internally consistent` asserts the relationship, because a swap between them is
 * silent and shifts every result by 29%. This was a real defect during the original build; see
 * DESIGN_NOTES.md F16.
 */
export const TWO_OVER_SQRT_PI = d(
  '1.1283791670955125738961589031215451716881012586579977136881714433276453523614898',
);

/**
 * `sqrt(2 / pi)` = 0.79788456080286535587989211986876373695171726232986931533185224. `E[|Z|]` for a
 * standard normal, and therefore the `c -> infinity` limit of the moment divided by sigma.
 */
export const SQRT_TWO_OVER_PI = d(
  '0.7978845608028653558798921198687637369517172623298693153318522425059570375383161',
);

/**
 * The Taylor series is used below this argument and the continued fraction above it. At 4 the series
 * still converges in about 60 terms with no cancellation, and the continued fraction is converging
 * in about 20.
 */
export const SERIES_BREAKPOINT = d(4);

/**
 * Above this magnitude `erf` is exactly 1 at the module's 50 digits (`erfc(11) = 1.5e-54`), so the
 * continued fraction is pure cost. Measured at 29.2% of the NIG quadrature's `Phi` arguments and a
 * factor of 2.4 on that path (F88).
 */
export const ERF_SATURATION = d(11);

const SERIES_MAX_TERMS = 200;
const CONTINUED_FRACTION_MAX_TERMS = 200;
const CONTINUED_FRACTION_EPSILON = d('1e-45');
const TINY = d('1e-60');

/** Thrown by a primitive that refuses its input. */
export class MomentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MomentsError';
  }
}

/** The standard normal density, `phi(x) = exp(-x^2 / 2) / sqrt(2 pi)`. */
export function standardNormalPdf(x: Decimal): Decimal {
  return x.times(x).div(2).neg().exp().div(SQRT_TWO_PI);
}

/** The standard normal distribution function, `Phi(x) = (1 + erf(x / sqrt(2))) / 2`. */
export function standardNormalCdf(x: Decimal): Decimal {
  return d(1)
    .plus(erf(x.div(SQRT_TWO)))
    .div(2);
}

/**
 * `E[ min(|G|, c) ]` for `G ~ N(mu, sigma^2)`, with `c = 1 / lam`.
 *
 * This is the paper's Eq (12), and `lam * truncatedAbsMoment(...)` is the fair long premium.
 *
 * Conventions, matching `Stat.truncatedAbsMoment` exactly so the two cannot drift:
 *   - `sigma == 0`: the gap is identically zero, so the moment is zero.
 *   - `lam == 0`: `c` is infinite, so the moment is the untruncated `E[|G|] = sigma sqrt(2/pi)`.
 *     This is the paper's stated `c -> infinity` limit, which makes the two branches continuous.
 *   - a non-zero `mu` is refused, not approximated: `|G|` is then folded normal and the truncated
 *     moment has no closed form. The protocol's model is `G ~ N(0, sigma^2)`.
 *
 * Note the deliberate absence of `E[|G| ** (1/lam)]`. The build brief's §2.4 writes the primitive
 * that way; the paper's Eq (12) and the brief's own Appendix A fixture both contradict it, and
 * ruling R1 in DESIGN_NOTES.md settles it in the paper's favour.
 */
export function truncatedAbsMoment(lam: Decimal, mu: Decimal, sigma: Decimal): Decimal {
  if (!mu.isZero()) {
    throw new MomentsError('truncatedAbsMoment is defined for a zero mean only');
  }
  if (sigma.isZero()) return d(0);
  if (lam.isZero()) return sigma.times(SQRT_TWO_OVER_PI);
  return truncatedAbsMomentAtCap(d(1).div(lam), sigma);
}

/**
 * `E[ min(|G|, cap) ]` for `G ~ N(0, sigma^2)`, given the cap directly.
 *
 * Split at `|G| = cap`: the inner integral is `-phi`, the outer term is `cap * P(|G| >= cap)`.
 */
export function truncatedAbsMomentAtCap(cap: Decimal, sigma: Decimal): Decimal {
  if (sigma.isZero()) {
    throw new MomentsError('the cap form requires a non-zero sigma');
  }
  const standardised = cap.div(sigma);
  const body = sigma.times(2).times(standardNormalPdf(d(0)).minus(standardNormalPdf(standardised)));
  const tail = cap.times(2).times(d(1).minus(standardNormalCdf(standardised)));
  return body.plus(tail);
}

/**
 * `dp/dlambda = E[ |G| * 1{ |G| <= 1/lambda } ]` for `G ~ N(0, sigma^2)`.
 *
 * The derivative of the fair premium in the leverage, and therefore the value of one lattice step of
 * leverage error per unit of notional. This is the identity that sizes the publisher bond: at NVDA's
 * overnight parameters it is 1.1119% of notional, which on $8.53M of committed depth is $94,849, and
 * three times that rounds up to the $500,000 bond (paper §7.11, Table 19).
 */
export function truncatedFirstMoment(lam: Decimal, sigma: Decimal): Decimal {
  if (sigma.isZero()) return d(0);
  if (lam.isZero()) return sigma.times(SQRT_TWO_OVER_PI);
  const standardised = d(1).div(lam).div(sigma);
  return sigma.times(2).times(standardNormalPdf(d(0)).minus(standardNormalPdf(standardised)));
}

/**
 * The error function, to working precision.
 *
 * Odd in `z`, so only the magnitude is evaluated. Below the series breakpoint the Maclaurin series
 * `erf(z) = (2/sqrt(pi)) * sum (-1)^n z^(2n+1) / (n! (2n+1))` is used; between there and
 * `ERF_SATURATION` the complementary function is taken from the continued fraction, because the
 * series suffers catastrophic cancellation in the tail while the fraction does not; at and above
 * `ERF_SATURATION` the result is exactly 1 (F88).
 */
export function erf(z: Decimal): Decimal {
  if (z.isZero()) return d(0);
  if (z.isNegative()) return erf(z.neg()).neg();
  if (z.gte(ERF_SATURATION)) return d(1);
  if (z.lte(SERIES_BREAKPOINT)) return erfSeries(z);
  return d(1).minus(erfcContinuedFraction(z));
}

/** Maclaurin series for `erf`, valid without cancellation up to `SERIES_BREAKPOINT`. */
function erfSeries(z: Decimal): Decimal {
  let total = z;
  let term = z;
  const square = z.times(z);
  for (let n = 1; n < SERIES_MAX_TERMS; n += 1) {
    term = term.times(square).div(n).neg();
    const contribution = term.div(2 * n + 1);
    total = total.plus(contribution);
    if (contribution.abs().lt(CONTINUED_FRACTION_EPSILON)) break;
  }
  return TWO_OVER_SQRT_PI.times(total);
}

/**
 * `erfc(z)` from `erfc(z) = exp(-z^2) / sqrt(pi) * 1/(z + 1/2/(z + 1/(z + 3/2/(z + ...))))`.
 *
 * Evaluated by the modified Lentz algorithm, which is numerically stable for this fraction. The two
 * zero guards are part of the published algorithm rather than defensive noise: the recurrence divides
 * by `d` and by `c`, and the algorithm specifies substituting a tiny value rather than allowing a
 * division by zero.
 */
function erfcContinuedFraction(z: Decimal): Decimal {
  const numerator = z.times(z).neg().exp().div(SQRT_PI);
  let fraction = z;
  let c = fraction;
  let dd = d(0);
  for (let n = 1; n < CONTINUED_FRACTION_MAX_TERMS; n += 1) {
    const a = d(n).div(2);
    dd = z.plus(a.times(dd));
    // The two zero guards below are transcribed from the published algorithm, not defensive coding:
    // the recurrence divides by `dd` and by `c`, and the algorithm specifies substituting a tiny
    // value rather than allowing a division by zero. Neither has fired in 6,338 iterations — for the
    // arguments this module is asked about the convergents are never exactly zero — and they are
    // hinted rather than tested, because a test that reached them would have to drive the continued
    // fraction to a state the algorithm's own inputs do not produce.
    /* v8 ignore next */
    if (dd.isZero()) dd = TINY;
    c = z.plus(a.div(c));
    /* v8 ignore next */
    if (c.isZero()) c = TINY;
    dd = d(1).div(dd);
    const delta = c.times(dd);
    fraction = fraction.times(delta);
    if (delta.minus(1).abs().lt(CONTINUED_FRACTION_EPSILON)) break;
  }
  return numerator.div(fraction);
}
