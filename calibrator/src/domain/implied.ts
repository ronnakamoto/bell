/**
 * BELL-IV: the pool price inverted into an implied session volatility, and the freshness guard that
 * stops a frozen pool reporting an old volatility as a current one.
 *
 * Paper §5.2, contribution 3, and Table 31's P1 gate. Because `E[min(|G|, c)]` is strictly increasing
 * in `sigma` and maps `[0, inf)` onto `[0, c)`, the pool price inverts uniquely (Eq 13):
 *
 *     sigma_hat = the unique sigma solving   lam * E[min(|G|, c)] = pL,    c = 1 / lam.
 *
 * **The root-find is done in the truncation ratio, not in the volatility.** Write `u = c / sigma` and
 * `g(u) = E[min(|Z|, u)]`. Then `E[min(|G|, c)] = sigma * g(u)` and `lam * sigma = 1 / u`, so
 *
 *     lam * E[min(|G|, c)]  =  g(u) / u  =  h(u),
 *
 * and the equation is `h(u) = pL` — a function of `u` alone, with `lam` entering only through the
 * final `sigma = 1 / (lam * u)`. This is the same equation Eq (13) states, in the variable that makes
 * it well conditioned. Three consequences, and all three are load-bearing:
 *
 *   - `h` is a fixed function `(0, inf) -> (0, 1)` and is strictly decreasing, so the inversion is a
 *     one-dimensional root-find whose bracket always closes and whose answer does not depend on the
 *     leverage at all. `h'(u) = -2(phi(0) - phi(u)) / u^2`, which is negative for every `u > 0`.
 *   - The reachable set is provable rather than asserted: **`pL >= 1` has no solution**, because
 *     `h(u) < 1` for every `u` and `h(u) -> 1` only as `u -> 0`. The same statement in the original
 *     variables is `lam * c = 1`, the saturation ceiling. A price at or above it is refused here
 *     rather than inverted to a large sigma.
 *   - The relative error in `u` **is** the relative error in `sigma`, because `sigma = 1 / (lam * u)`.
 *     The paper's M15 bound is therefore a statement about solving `h(u) = pL`, and that is what the
 *     suite measures.
 *
 * **The bracket is closed form, and the root-find is Newton inside it.** Two bounds on `h` hold for
 * every `u > 0` and together they bound the root without a single doubling step:
 *
 *     h(u) >= 1 - 2 phi(0) u   gives   u >= (1 - pL) / sqrt(2/pi)
 *     h(u) <= sqrt(2/pi) / u   gives   u <= sqrt(2/pi) / pL
 *
 * The second is the Mills ratio (`1 - Phi(u) <= phi(u)/u`); the first follows from
 * `h(u) >= 2(1 - Phi(u))`, whose two sides agree to first order at zero. Both are stated with
 * `sqrt(2/pi)`, which is exactly `2 phi(0)`. Newton then converges quadratically inside the bracket,
 * and a rejected step falls back to bisecting it, so the worst case is the bisection the first draft
 * used and the usual case is about eight evaluations rather than sixty.
 *
 * **The stopping rule is the input's own granularity, not an iteration count.** The pool price
 * arrives as a `Wad`, so it carries no information about `sigma` below one wei; the root-find stops
 * when `|h(u) - pL|` is at most one wei. That makes the achieved accuracy a *derived* quantity —
 * `du / u <= quantum / (pL |e_h|)`, where `|e_h| = |u h'/h|` is the price elasticity — rather than a
 * number the algorithm happens to reach, and the suite checks that inequality at every point rather
 * than pinning a worst case. The 112 points of `spec/fixtures/moments.json` are the corpus: the
 * Python reference's `(lambda, sigma) -> premium` at fifty digits, so inverting its `premiumWad` and
 * recovering its `sigmaWad` is a round trip through a foreign implementation and not a re-derivation
 * of this one. All 112 recover, worst relative error **3.195e-17** against the paper's M15 bound of
 * 1.16e-13 — a factor of 3630 inside it, and the bound that explains the figure is the price quantum
 * over the price rather than the fifty digits of the arithmetic. See `DESIGN_NOTES.md` F91.
 *
 * **What the paper's M14 check measures, and what it does not.** The published "minimum discrete
 * derivative 4.023e-01 over 5 truncation ratios x 400 volatilities" is reproduced exactly as
 * `unitCapMoment(1/2) = 0.40229144600025329669`, which identifies the quantity: it is `dE/dsigma`
 * along a ray where the cap scales with `sigma`, i.e. `g(u)` itself. The derivative that governs the
 * inversion at a *fixed* leverage is a different one, `2(phi(0) - phi(u))`, and on the same ratio grid
 * its minimum is `9.375390727426640041e-02`, not 0.4023. Both are pinned in the suite. This does not
 * make the map non-invertible — it is strictly increasing either way — but the check's number is not
 * the number its stated purpose needs, and `DESIGN_NOTES.md` F91 records the measurement.
 *
 * Pure: no I/O, no clock, no global state, no `Math`, no `number`. Everything is a `Wad` at 1e18 or a
 * `Decimal` at the domain's declared precision.
 */

import { type Decimal } from 'decimal.js';

import { STALENESS_SESSIONS, WAD } from './constants.js';
import { Wad } from './models.js';
import { D, SQRT_TWO_OVER_PI, standardNormalPdf, truncatedAbsMomentAtCap } from './moments.js';

/** Thrown by the implied-volatility surface when it refuses its input. */
export class ImpliedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpliedError';
  }
}

/** `WAD` as a decimal, for the conversions below. Derived, never written down a second time. */
const WAD_DECIMAL = new D(WAD.toString());

const ONE = new D(1);

/** One wei as a dimensionless price: the finest distinction the input can carry. */
const PRICE_QUANTUM = new D('1e-18');

/**
 * The iteration cap.
 *
 * Unreachable, and the argument is short. The bracket is closed form and finite, Newton converges
 * quadratically inside it, and a rejected step falls back to halving it — so the sequence is bounded
 * by the bisection it degrades to, which from a bracket of relative width one reaches `1e-18` in
 * about sixty halvings. Measured on the committed fixture, the root-find returns in six to nine
 * iterations at every one of the 112 points. The cap is kept because the alternative is an unbounded
 * loop in the domain, and it is hinted rather than tested because the only test that could reach it
 * would have to drive the iteration to a state its own arithmetic cannot produce.
 */
const MAX_ITERATIONS = 200;

/**
 * `g(u) = E[min(|Z|, u)]`, the truncated absolute moment of a *standard* normal at cap `u`.
 *
 * The paper's Eq (12) with `sigma = 1`. This is the whole of the inversion's arithmetic: every
 * quantity below is either this function or a ratio of it.
 *
 * Refuses a non-positive cap. `truncatedAbsMomentAtCap` already refuses a zero sigma, and the cap is
 * the quantity this module is asked to reason about, so the guard belongs here rather than at the
 * caller — the same placement `Amm`'s reserve check has (DESIGN_NOTES.md F44/F45).
 */
export function unitCapMoment(cap: Decimal): Decimal {
  if (!cap.isFinite() || cap.lte(0)) {
    throw new ImpliedError('a truncation cap must be positive and finite');
  }
  return truncatedAbsMomentAtCap(cap, ONE);
}

/**
 * `h(u) = g(u) / u`, the dimensionless pool price.
 *
 * Strictly decreasing, mapping `(0, inf)` onto `(0, 1)`: `h(u) -> 1` as `u -> 0` and
 * `h(u) -> sqrt(2/pi) / u -> 0` as `u -> inf`. Its inverse is the inversion, so this function is the
 * one that carries the reachability statement — `h` never reaches 1, and never reaches 0.
 */
export function dimensionlessPrice(ratio: Decimal): Decimal {
  if (!ratio.isFinite() || ratio.lte(0)) {
    throw new ImpliedError('a truncation ratio must be positive and finite');
  }
  return unitCapMoment(ratio).div(ratio);
}

/** The dimensionless price of a zero, for the derivative below. `phi(0) = 1/sqrt(2 pi)`. */
const ZERO = new D(0);

/**
 * `h'(u) = -2 (phi(0) - phi(u)) / u^2`, the derivative of the dimensionless price.
 *
 * Negative for every positive `u`, which is what makes the inversion a monotone one-dimensional
 * root-find and what lets Newton use it as a slope without a sign check.
 *
 * **It is also the paper's own first absolute moment, standardised, and the argument order is easy to
 * get backwards.** `truncatedFirstMoment(lam, sigma)` is `sigma * 2 * (phi(0) - phi(1/(lam*sigma)))`,
 * so the arguments that produce `2(phi(0) - phi(u))` are `lam = 1/u, sigma = 1` — not `lam = 1,
 * sigma = u`, which produces `u * 2 * (phi(0) - phi(1/u))` and agrees with the first only as
 * `u -> infinity`. At `u = 1/2` the two differ by a factor of 7.4, and the first draft of the
 * reconnaissance here used the wrong one and reported a Newton step seven times too short.
 *
 * Written out rather than delegated to `truncatedFirstMoment` so that the ratio-only form is visible:
 * this module's whole arithmetic is a function of `u`, and a call that takes a leverage and a
 * volatility would obscure that.
 */
function dimensionlessPriceDerivative(ratio: Decimal): Decimal {
  return standardNormalPdf(ZERO)
    .minus(standardNormalPdf(ratio))
    .times(2)
    .neg()
    .div(ratio.times(ratio));
}

/**
 * The unique `u` solving `h(u) = price`.
 *
 * Newton inside a closed-form bracket, with a bisection fallback for a rejected step. The bracket is
 * `[(1 - pL) / sqrt(2/pi), sqrt(2/pi) / pL]` and needs no search: both bounds hold for every `u > 0`,
 * so the root is inside them by construction. See the note at the head of this file for the two
 * inequalities.
 *
 * The stopping rule is the price quantum rather than an iteration count. The caller's price is a
 * `Wad`, so once `h` is within one wei of it no further step can change the answer the input
 * supports; the accuracy this buys is `quantum / (pL |e_h|)`, which is derived rather than observed.
 *
 * Refuses a price outside `(0, 1)`. Both ends matter. At `price <= 0` the bracket's upper end is
 * infinite; at `price >= 1` there is no root at all, and returning a large `sigma` would report a
 * volatility the price cannot represent.
 */
export function capRatioForPrice(price: Decimal): Decimal {
  if (!price.isFinite() || price.lte(0) || price.gte(1)) {
    throw new ImpliedError(
      'the pool price must lie strictly between 0 and 1: h maps (0, inf) onto (0, 1), so no ' +
        'volatility reproduces a price at or above the saturation ceiling',
    );
  }

  // `sqrt(2/pi)` is `2 phi(0)` exactly, and it is the constant that appears in both bounds. Written
  // through the imported value rather than through `2 * standardNormalPdf(0)`, so that the one
  // published constant has one spelling -- `TWO_OVER_SQRT_PI` differs from it by a factor of pi/2 and
  // the two have been confused here before (DESIGN_NOTES.md F16).
  const lower = ONE.minus(price).div(SQRT_TWO_OVER_PI);
  const upper = SQRT_TWO_OVER_PI.div(price);

  let lowRatio = lower;
  let highRatio = upper;
  let ratio = lower.plus(upper).div(2);

  for (let iterations = 0; iterations < MAX_ITERATIONS; iterations += 1) {
    const residual = dimensionlessPrice(ratio).minus(price);
    if (residual.abs().lte(PRICE_QUANTUM)) {
      return ratio;
    }
    // `h` is decreasing, so a positive residual moves the *lower* end up.
    if (residual.gt(0)) {
      lowRatio = ratio;
    } else {
      highRatio = ratio;
    }
    let next = ratio.minus(residual.div(dimensionlessPriceDerivative(ratio)));
    if (next.lte(lowRatio) || next.gte(highRatio)) {
      next = lowRatio.plus(highRatio).div(2);
    }
    ratio = next;
  }
  /* v8 ignore next 3 */
  throw new ImpliedError(
    `the root-find did not reach the price quantum in ${String(MAX_ITERATIONS)} steps`,
  );
}

/** A WAD integer as the dimensionless `Decimal` the arithmetic above takes. */
function dimensionless(wadValue: bigint): Decimal {
  return new D(wadValue.toString()).div(WAD_DECIMAL);
}

/**
 * A dimensionless `Decimal` back at WAD scale, rounded half-even.
 *
 * **Deliberately a second copy of `families/gaussian.ts`'s `toWad`, and the duplication is checked
 * rather than trusted.** The suite asserts the two agree on a set of values, which is the discipline
 * `families/base.ts` applies to its own duplicated nearest-rank rule. The reason for a second copy is
 * the import graph: this module is the pool-price surface, and a BELL-IV inversion that read as
 * depending on the *Gaussian family strategy* would misdescribe the design — the conversion is
 * generic and only happens to live next to the family that first needed it.
 *
 * Half-even rather than truncated, for the reason stated there: the primitive computes at fifty
 * digits and the WAD grid has eighteen, so a quantisation is unavoidable and the cost is half a wei
 * either way. Truncating would bias every volatility downwards, and a one-signed bias in the
 * direction of cheapness is the wrong one for a protocol that writes the number into a haircut.
 */
function toWad(value: Decimal): Wad {
  return Wad.fromRaw(BigInt(value.times(WAD_DECIMAL).toNearest(1, D.ROUND_HALF_EVEN).toFixed(0)));
}

/**
 * `sigma_hat`: the unique `sigma` with `lam * E[min(|G|, 1/lam)] = price`.
 *
 * Paper Eq (13). The pool price `price` is the long claim's price as a fraction of notional, which is
 * `lam * E[min(|G|, c)]` itself, so the two arguments are the leverage the pool is listed at and the
 * price it is trading at.
 *
 * The leverage is refused if it is not positive rather than allowed to become `c = inf`: at `lam = 0`
 * the truncation never binds and the premium is `sigma * sqrt(2/pi)` for every `sigma`, so the price
 * carries no volatility information at all and there is nothing to invert.
 */
export function impliedVolatility(lam: Wad, price: Wad): Wad {
  if (lam.raw <= 0n) {
    throw new ImpliedError(
      'a leverage must be positive: with no truncation the price is proportional to sigma and ' +
        'carries no volatility information',
    );
  }
  const ratio = capRatioForPrice(dimensionless(price.raw));
  return toWad(ONE.div(dimensionless(lam.raw).times(ratio)));
}

/**
 * Where a published volatility came from.
 *
 * A named union rather than a boolean, because the provenance stamp is the paper's mechanism for
 * making a stale reading *visible*: `trailing-realised` is a different claim from `pool`, and a
 * consumer deciding whether to trust the number needs to see which one it is holding.
 */
export type VolatilityProvenance = 'pool' | 'trailing-realised';

/** A volatility with its provenance: the value, the session it is about, and where it came from. */
export class VolatilityReading {
  /** The volatility, as a fraction of notional at WAD scale. */
  readonly sigmaWad: bigint;

  /** The session this reading is *about*, not the session it was published in. */
  readonly session: bigint;

  /** Which estimator produced it. */
  readonly provenance: VolatilityProvenance;

  constructor(fields: { sigmaWad: bigint; session: bigint; provenance: VolatilityProvenance }) {
    this.sigmaWad = fields.sigmaWad;
    this.session = fields.session;
    this.provenance = fields.provenance;
  }

  /**
   * How many sessions old this reading is at `session`.
   *
   * Refuses a session earlier than the reading's own. A reading from the future is not a stale
   * reading, it is a caller error, and the two must not be conflated: a negative age compared against
   * a staleness bound would read as maximally fresh, which is the one direction that fails unsafe.
   */
  ageAt(session: bigint): bigint {
    if (session < this.session) {
      throw new ImpliedError(
        `a reading for session ${String(this.session)} cannot be aged at session ${String(session)}`,
      );
    }
    return session - this.session;
  }
}

/**
 * Which source the published reading must come from.
 *
 * The bound is **inclusive**: a parameter set is usable *within* the stated number of sessions, so an
 * age equal to the bound is still the pool's own reading and one session past it is not. The reading
 * of Table 19 supports that direction — the rotation period equals the staleness bound and the bond
 * lock is one session longer — and the alternative would price on a set that the rotation rule
 * already treats as due for replacement.
 */
export function volatilitySource(ageSessions: bigint, boundSessions: bigint): VolatilityProvenance {
  if (ageSessions < 0n) {
    throw new ImpliedError('an age cannot be negative');
  }
  if (boundSessions < 0n) {
    throw new ImpliedError('a staleness bound cannot be negative');
  }
  return ageSessions <= boundSessions ? 'pool' : 'trailing-realised';
}

/**
 * The reading to publish for `session`.
 *
 * The pool's own reading while it is within the bound; beyond it the named trailing-realised fallback,
 * which is the paper's fix for "a pool that has not traded reports the old volatility exactly". With
 * no fallback supplied the call refuses — that is Table 19's "the pool refuses to price rather than
 * pricing on a stale fit", and it is the reason this returns a reading rather than a boolean: a caller
 * cannot render a refusal as a number.
 *
 * `boundSessions` defaults to the protocol's published staleness bound, which is the only value the
 * design states. It is a parameter so that the rule is testable against a bound rather than against
 * one constant, and the default is the constant so that a caller does not restate it.
 */
export function publishedVolatility(
  pool: VolatilityReading,
  session: bigint,
  fallback: VolatilityReading | null,
  boundSessions: bigint = STALENESS_SESSIONS,
): VolatilityReading {
  const age = pool.ageAt(session);
  if (volatilitySource(age, boundSessions) === 'pool') {
    return pool;
  }
  if (fallback === null) {
    throw new ImpliedError(
      `a pool reading ${String(age)} sessions old needs a trailing-realised fallback and none was ` +
        'supplied: the pool refuses to price rather than pricing on a stale fit',
    );
  }
  return fallback;
}
