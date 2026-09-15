/**
 * The event-session shrinkage rule, against Table 17.
 *
 * **No oracle, and the evidence is a published column rather than a differential.** The Python never
 * implemented the event session — `is_pooled_with_weekend` is the closest it came — so there is
 * nothing to diff against. What stands in for the oracle is the paper's own parameter set: Table 17
 * publishes `r`, `SE(r)`, `r*`, `sigma_C*`, `lambda_C` and the interval for all 22 names, and every
 * one of them is a checkable consequence of the rule. That is a stronger position than a differential,
 * because the table was produced by the design rather than by the implementation being ported.
 *
 * **What this file can and cannot constrain, stated because the difference is easy to miss.**
 * `sigma_nonC` — the name's non-event scale — is *not* published; Table 17 publishes only
 * `sigma_C* = r* * sigma_nonC`, to two decimals. So the suite checks the rule at the point the table
 * fixes it, which is the scale: `eventLeverage` takes `sigma_C*` and is asserted against the published
 * `lambda_C`, and the one composition step (`eventScale`) gets a fixture of its own. A test that
 * reconstructed `sigma_nonC` from `sigma_C* / r*` in order to feed a `(r*, sigma_nonC)` signature
 * would cancel the factor it claimed to be checking, and would pass for any implementation of the
 * quotient — which is why the signature takes the scale (`DESIGN_NOTES.md` F89).
 *
 * **The tolerances are derived, not fitted.** The `r*` column is checked against `1.0e-3`, which is
 * `5e-4 + 5e-4`: the input `r` is published at 3 dp and so is the output `r*`, and `r*` is a convex
 * combination of `r` and the mean of `r`, so each rounding displaces it by at most half a step in the
 * last place. The measured worst is NVDA at 9.2866e-4, 93% of that bound and pinned below. The
 * `lambda_C` column is checked for *equality*, because it is an integer and the rule that produces it
 * is exact at the published precision — all 22 reproduce. The interval column is checked as 21 of 22,
 * with the single miss explained rather than excused: KO's low end is 17.98 against a published 18,
 * and the scale that would flip it is 0.099% below the published 2-dp value while that value's own
 * quantisation is ±0.23%.
 *
 * **The cross-sectional spread is checked against the column, not just against its own formula.** The
 * module carries `tau` unrounded, deviating from the tracker's stated 1.596, and the last block below
 * is what justifies that: the estimator recomputed from the published `r` and `SE(r)` columns lands on
 * 1.596142019, and a least-squares fit of `tau` to the published `r*` column lands on 1.596337 — two
 * independent routes agreeing to 0.012%. The rounded 1.596 is 4.0% worse in rms and misses the
 * published third decimal on two names rather than one.
 *
 * **The order of the band's ends is asserted.** `eventLeverageBand` returns ascending, which is the
 * opposite of the order the arithmetic produces, and the first draft of the module got it wrong. A
 * test that only compared the pair as a set would not have caught that.
 */

import { type Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { EVENT_SESSION_CROSS_SECTIONAL_TAU_WAD } from '../../src/domain/constants.js';
import { Wad } from '../../src/domain/models.js';
import { D } from '../../src/domain/moments.js';
import {
  eventLeverage,
  eventLeverageBand,
  eventScale,
  pooledMultiplier,
  ShrinkageError,
  shrinkageWeight,
  shrunkMultiplier,
} from '../../src/domain/shrinkage.js';

/** A decimal literal at WAD scale, exactly. */
const wad = (value: string): Wad => Wad.fromStr(value);

/** A whole number as a `Wad`. */
const whole = (value: number): Wad => Wad.fromWhole(BigInt(value));

/** A dimensionless decimal at the domain's working precision. */
const d = (value: string): Decimal => new D(value);

/** `|a - b|` at WAD scale. */
function absDiff(left: Wad, right: Wad): bigint {
  const diff = left.raw - right.raw;
  return diff < 0n ? -diff : diff;
}

/** `value` rounded to the three decimals the table prints. */
function toMilli(value: Wad): string {
  return d(value.raw.toString()).div('1e18').toDecimalPlaces(3).toFixed(3);
}

/**
 * Table 17, transcribed: name, `r`, `SE(r)`, `r*`, `sigma_C*` as a fraction, `lambda_C`, interval.
 *
 * The table's `sigma_C*` is printed as a percentage and stored here as a fraction, because the rule
 * takes a dimensionless scale and a percentage would put a factor of 100 in the test that is not in
 * the module. `0.0370` keeps the trailing zero the table prints, so the fixture reads as the table.
 */
const ROWS = [
  ['AAPL', '3.341', '0.399', '3.402', '0.0370', 11, 10, 13],
  ['AMD', '3.938', '0.478', '3.974', '0.0796', 5, 4, 6],
  ['AMZN', '5.424', '0.648', '5.275', '0.0633', 6, 6, 7],
  ['AVGO', '3.452', '0.419', '3.511', '0.0513', 8, 7, 9],
  ['COIN', '2.856', '0.505', '2.994', '0.0916', 4, 4, 5],
  ['CRM', '5.715', '0.693', '5.502', '0.0676', 6, 5, 7],
  ['GOOGL', '5.308', '0.634', '5.180', '0.0546', 7, 7, 9],
  ['INTC', '4.522', '0.540', '4.507', '0.0741', 5, 5, 6],
  ['JPM', '1.996', '0.239', '2.048', '0.0227', 19, 17, 21],
  ['KO', '3.033', '0.363', '3.099', '0.0217', 20, 18, 22],
  ['META', '8.089', '0.967', '7.091', '0.0915', 4, 4, 5],
  ['MSFT', '3.868', '0.462', '3.907', '0.0388', 11, 10, 12],
  ['MU', '3.531', '0.422', '3.586', '0.0700', 6, 5, 7],
  ['NFLX', '8.883', '1.062', '7.499', '0.0858', 5, 4, 5],
  ['NVDA', '4.729', '0.574', '4.689', '0.0786', 5, 4, 6],
  ['ORCL', '5.432', '0.659', '5.278', '0.0728', 5, 5, 6],
  ['PG', '4.487', '0.536', '4.475', '0.0272', 16, 14, 18],
  ['PLTR', '4.432', '0.719', '4.422', '0.1014', 4, 3, 5],
  ['QCOM', '4.375', '0.523', '4.375', '0.0606', 7, 6, 8],
  ['SMCI', '3.493', '0.504', '3.573', '0.0919', 4, 4, 5],
  ['TSLA', '3.557', '0.425', '3.611', '0.0763', 5, 5, 6],
  ['XOM', '1.714', '0.205', '1.757', '0.0200', 21, 19, 24],
] as const;

/** The measured multipliers, which is what the pool is taken over. */
const multipliers = (): readonly Wad[] => ROWS.map((row) => wad(row[1]));

/** The published `sigma_C*` for `name`, or a failure naming the fixture rather than an undefined. */
function scaleOf(name: string): Wad {
  const row = ROWS.find((candidate) => candidate[0] === name);
  if (row === undefined) throw new Error(`Table 17 has no row for ${name}`);
  return wad(row[4]);
}

/** The bound the published precision permits: two half-steps at 3 dp. */
const ROUNDING_BOUND = 1_000_000_000_000_000n;

/** Table 17's own mean, floored at WAD scale. */
const POOLED_RAW = 4_371_590_909_090_909_090n;

/**
 * The shrink rule again, written out at full precision and parameterised by `tau`.
 *
 * A second implementation, deliberately: it is what lets the last block below score one `tau` against
 * another without going through the module's constant. It is the same algebra as `shrunkMultiplier`,
 * so a disagreement between the two would be a disagreement about `tau` and nothing else.
 */
function shrinkWith(
  tau: Decimal,
  multiplier: Decimal,
  standardError: Decimal,
  pooled: Decimal,
): Decimal {
  const squared = tau.times(tau);
  const weight = squared.div(squared.plus(standardError.pow(2)));
  return weight.times(multiplier).plus(d('1').minus(weight).times(pooled));
}

/** The exact mean of the published multipliers, at the domain's working precision. */
function exactPooled(): Decimal {
  const values = ROWS.map((row) => d(row[1]));
  return values.reduce((sum, value) => sum.plus(value)).div(values.length);
}

/** The root-mean-square deviation of a `tau`'s shrunk column from the published `r*` column. */
function rmsAgainstColumn(tau: Decimal): Decimal {
  const pooled = exactPooled();
  const total = ROWS.reduce(
    (sum, row) => sum.plus(shrinkWith(tau, d(row[1]), d(row[2]), pooled).minus(row[3]).pow(2)),
    d('0'),
  );
  return total.div(ROWS.length).sqrt();
}

describe('the cross-sectional mean', () => {
  it("is the unweighted mean of Table 17's multipliers", () => {
    // The estimator's target. An earlier candidate — the precision-weighted mean — is 3.253 on this
    // column, and the implied target of each published r* lands on this one rather than that one.
    expect(pooledMultiplier(multipliers()).raw).toBe(POOLED_RAW);
    expect(pooledMultiplier(multipliers()).toDecimalString()).toBe('4.37159090909090909');
  });

  it('refuses a universe with no names', () => {
    expect(() => pooledMultiplier([])).toThrow(ShrinkageError);
    expect(() => pooledMultiplier([])).toThrow(/at least one name/);
  });

  it('is the value itself when the universe is one name', () => {
    expect(pooledMultiplier([wad('3.341')]).raw).toBe(wad('3.341').raw);
  });
});

describe('the cross-sectional spread', () => {
  it('is the method-of-moments estimator over the published columns', () => {
    // Recomputed here from Table 17's own `r` and `SE(r)` columns rather than read back from the
    // module, so this checks the constant rather than restating it. The sample variance (n - 1) is
    // load-bearing: the `n` form gives 1.554552 and the uncorrected sqrt(var(r)) gives 1.697890, and
    // neither reproduces the published column.
    const values = ROWS.map((row) => d(row[1]));
    const mean = values.reduce((sum, value) => sum.plus(value)).div(values.length);
    const variance = values
      .reduce((sum, value) => sum.plus(value.minus(mean).pow(2)), d('0'))
      .div(values.length - 1);
    const meanSquaredError = ROWS.reduce((sum, row) => sum.plus(d(row[2]).pow(2)), d('0')).div(
      ROWS.length,
    );
    const tau = variance.minus(meanSquaredError).sqrt();

    expect(tau.toFixed(9)).toBe('1.596142019');
    expect(variance.minus(meanSquaredError).toFixed(9)).toBe('2.547669344');
    // And the emitted constant is that value, to the six decimals the YAML carries. The tracker states
    // 1.596; this is the unrounded estimator, and the next test is why.
    expect(d(EVENT_SESSION_CROSS_SECTIONAL_TAU_WAD.toString()).div('1e18').toFixed(6)).toBe(
      tau.toFixed(6),
    );
  });

  it("is the value the published r* column prefers to the brief's rounded 1.596", () => {
    // Two independent routes to the same number. The estimator above comes from `r` and `SE(r)`; this
    // one comes from the `r*` column those were used to produce, and the two agree to 0.012%.
    const optimum = d('1.596337');
    const unrounded = rmsAgainstColumn(d('1.596142'));
    const rounded = rmsAgainstColumn(d('1.596'));
    const best = rmsAgainstColumn(optimum);

    expect(best.lt(unrounded)).toBe(true);
    expect(unrounded.lt(rounded)).toBe(true);
    // The optimum sits 0.012% from the method-of-moments estimator, which is well inside what a column
    // printed to three decimals can resolve.
    expect(optimum.minus(d('1.596142')).div('1.596142').times(100).toFixed(3)).toBe('0.012');
    // The least-squares optimum is 2.1% better in rms than the unrounded estimator, and the brief's
    // rounded value is 4.0% worse than it — the two are 6.2% apart, which is what the fourth digit is
    // worth here. The paper's body figure of 1.58 is not in the same regime at all: 17x worse, and it
    // misses the published third decimal on 18 names of 22.
    expect(unrounded.div(best).minus(1).times(100).toFixed(1)).toBe('2.1');
    expect(rounded.div(unrounded).minus(1).times(100).toFixed(1)).toBe('4.0');
    expect(rounded.div(best).minus(1).times(100).toFixed(1)).toBe('6.2');
    expect(rmsAgainstColumn(d('1.58')).div(unrounded).toFixed(1)).toBe('17.1');
  });
});

describe('the shrinkage weight', () => {
  it("spans 0.693 to 0.984 across the table's standard errors", () => {
    const weights = ROWS.map((row) => shrinkageWeight(wad(row[2])));
    const lowest = weights.reduce((a, b) => (a.lt(b) ? a : b));
    const highest = weights.reduce((a, b) => (a.gt(b) ? a : b));

    // The published range, and the extremes are named: NFLX has the widest standard error relative to
    // the spread and so shrinks most; XOM has the narrowest and shrinks least.
    expect(lowest.toFixed(3)).toBe('0.693');
    expect(highest.toFixed(3)).toBe('0.984');
    expect(shrinkageWeight(wad('1.062')).toFixed(3)).toBe('0.693');
    expect(shrinkageWeight(wad('0.205')).toFixed(3)).toBe('0.984');
  });

  it('is one when the measurement carries no uncertainty', () => {
    // The correct limit: a measurement with no standard error is not improved by being moved. Not
    // reachable from the table, where the smallest standard error is 0.205 against a multiplier of
    // 1.714 — but the branch is real and this is the site that reaches it.
    expect(shrinkageWeight(Wad.zero).toString()).toBe('1');
  });

  it('falls as the standard error rises', () => {
    const weights = ['0.1', '0.5', '1', '2', '4'].map((se) => shrinkageWeight(wad(se)));
    const ordered = weights.slice(1).every((weight, index) => {
      const previous = weights[index];
      return previous !== undefined && weight.lt(previous);
    });
    expect(ordered).toBe(true);
  });

  it('refuses a negative standard error', () => {
    // Not a small uncertainty — a sign error, and squaring it would hide that.
    expect(() => shrinkageWeight(Wad.fromWhole(-1n))).toThrow(/cannot be negative/);
  });
});

describe('the shrunk multiplier', () => {
  it('reproduces every published r* within the precision the inputs carry', () => {
    const pooled = pooledMultiplier(multipliers());
    for (const row of ROWS) {
      const computed = shrunkMultiplier(wad(row[1]), wad(row[2]), pooled);
      expect(absDiff(computed, wad(row[3]))).toBeLessThan(ROUNDING_BOUND);
    }
  });

  it('pins the worst case, which is NVDA at 93% of the bound', () => {
    const pooled = pooledMultiplier(multipliers());
    let worst = { name: '', deviation: 0n };
    for (const row of ROWS) {
      const deviation = absDiff(shrunkMultiplier(wad(row[1]), wad(row[2]), pooled), wad(row[3]));
      if (deviation > worst.deviation) worst = { name: row[0], deviation };
    }

    expect(worst.name).toBe('NVDA');
    expect(worst.deviation).toBe(928_665_745_351_821n);
    // 93% of the 1e-3 bound: the published column is close to the tightest it could be given that both
    // `r` and `r*` are printed to three decimals.
    expect(worst.deviation * 100n).toBeLessThan(ROUNDING_BOUND * 94n);
  });

  it('agrees with the published third decimal on 21 of 22 names', () => {
    const pooled = pooledMultiplier(multipliers());
    const offByOneInTheLastPlace = ROWS.filter((row) => {
      const computed = shrunkMultiplier(wad(row[1]), wad(row[2]), pooled);
      return toMilli(computed) !== row[3];
    }).map((row) => row[0]);

    // A tighter claim than the bound above and a weaker one than equality. NVDA is the single name
    // whose computed value rounds to 4.688 where the table prints 4.689, which is the same one-unit
    // discrepancy the bound is sized for — and the brief's rounded 1.596 would add NFLX to this list.
    expect(offByOneInTheLastPlace).toEqual(['NVDA']);
  });

  it('moves NFLX from 8.883 to 7.499 and XOM from 1.714 to 1.757', () => {
    // The tracker's named check. These are the two extremes of the multiplier range, and they are the
    // only names the paper says move materially.
    const pooled = pooledMultiplier(multipliers());
    expect(shrunkMultiplier(wad('8.883'), wad('1.062'), pooled).toDecimalString()).toBe(
      '7.498658472341888911',
    );
    expect(shrunkMultiplier(wad('1.714'), wad('0.205'), pooled).toDecimalString()).toBe(
      '1.757126811777552913',
    );
    expect(toMilli(shrunkMultiplier(wad('8.883'), wad('1.062'), pooled))).toBe('7.499');
    expect(toMilli(shrunkMultiplier(wad('1.714'), wad('0.205'), pooled))).toBe('1.757');
  });

  it('stays between the measurement and the pool', () => {
    // Convexity, which is what stops shrinkage manufacturing a value outside the range it was given.
    const pooled = pooledMultiplier(multipliers());
    for (const row of ROWS) {
      const computed = shrunkMultiplier(wad(row[1]), wad(row[2]), pooled);
      const measured = wad(row[1]);
      const lower = measured.raw < pooled.raw ? measured : pooled;
      const upper = measured.raw < pooled.raw ? pooled : measured;
      expect(computed.raw).toBeGreaterThanOrEqual(lower.raw);
      expect(computed.raw).toBeLessThanOrEqual(upper.raw);
    }
  });

  it('returns the measurement unchanged at zero standard error', () => {
    const pooled = pooledMultiplier(multipliers());
    expect(shrunkMultiplier(wad('8.883'), Wad.zero, pooled).toDecimalString()).toBe('8.883');
  });
});

describe('the event leverage', () => {
  it('reproduces every published lambda_C exactly', () => {
    for (const row of ROWS) {
      expect(eventLeverage(wad(row[4])).raw).toBe(whole(row[5]).raw);
    }
  });

  it('places the canonical three at 5, 5 and 11', () => {
    // The tracker's stated check, named separately so a regression reports which name moved.
    expect(eventLeverage(scaleOf('NVDA')).raw).toBe(whole(5).raw);
    expect(eventLeverage(scaleOf('TSLA')).raw).toBe(whole(5).raw);
    expect(eventLeverage(scaleOf('AAPL')).raw).toBe(whole(11).raw);
  });

  it('floors rather than rounds', () => {
    // sigma = 0.072782 puts the continuous leverage at 5.9894, so a rounding rule would publish 6 and
    // the session would saturate more often than the stated alpha.
    expect(eventLeverage(wad('0.072782')).raw).toBe(whole(5).raw);
    expect(eventLeverage(wad('0.0727')).raw).toBe(whole(5).raw);
    expect(eventLeverage(wad('0.0726')).raw).toBe(whole(6).raw);
  });

  it('refuses a non-positive scale', () => {
    expect(() => eventLeverage(Wad.zero)).toThrow(/positive scale/);
    expect(() => eventLeverage(Wad.fromWhole(-1n))).toThrow(ShrinkageError);
  });

  it('composes with the scale rule the table implies', () => {
    // `sigma_C* = r* * sigma_nonC`. Not checked against the published column, because `sigma_nonC` is
    // not published — see the file header. This is the arithmetic, on a round fixture and on the pair
    // the tracker names, where 4.689 * 1.6762% is the table's 7.86%.
    expect(eventScale(wad('2'), wad('0.05')).toDecimalString()).toBe('0.1');
    expect(eventScale(wad('4.689'), wad('0.016762')).toDecimalString()).toBe('0.078597018');
  });
});

describe('the leverage band', () => {
  it('reproduces the published interval on 21 of 22 names', () => {
    const misses: string[] = [];
    for (const row of ROWS) {
      const [low, high] = eventLeverageBand(wad(row[4]), wad(row[3]), wad(row[2]));
      if (low.raw !== whole(row[6]).raw || high.raw !== whole(row[7]).raw) misses.push(row[0]);
    }
    expect(misses).toEqual(['KO']);
  });

  it('misses KO by one step on the low end, inside the published scale rounding', () => {
    const [low, high] = eventLeverageBand(wad('0.0217'), wad('3.099'), wad('0.363'));
    expect(low.raw).toBe(whole(17).raw);
    expect(high.raw).toBe(whole(22).raw);

    // The continuous low end is 17.9821, so the miss is 0.0179 of a lattice step. The scale that would
    // flip it is 0.0216785 — 0.099% below the published 0.0217 — and the published value is quantised
    // at 2 dp, which is ±0.23% of itself. So the miss is inside the input's own rounding, and it is
    // recorded rather than absorbed by widening a tolerance that would then hide a real error.
    const relative = d('0.363').div('3.099');
    const continuous = d('1').div(d('2.294').times(d('0.0217').times(d('1').plus(relative))));
    expect(continuous.toFixed(4)).toBe('17.9821');

    const flip = d('1')
      .div(d('2.294').times(d('1').plus(relative)))
      .div(18);
    expect(flip.toFixed(7)).toBe('0.0216785');
    expect(d('0.0217').minus(flip).div('0.0217').times(100).toFixed(3)).toBe('0.099');
    expect(d('0.00005').div('0.0217').times(100).toFixed(2)).toBe('0.23');
  });

  it('returns the ends ascending, and not symmetrically', () => {
    // The upper multiplier gives the smaller leverage, because the leverage is the reciprocal of the
    // scale — so ascending is the opposite of the order the arithmetic produces, and the module's
    // first draft returned it descending.
    for (const row of ROWS) {
      const [low, high] = eventLeverageBand(wad(row[4]), wad(row[3]), wad(row[2]));
      expect(low.raw).toBeLessThanOrEqual(high.raw);
    }
    // AAPL: the point estimate is 11 and the band is 10 to 13, so the two ends are one and two lattice
    // steps away. A band on the *scale* would be symmetric in r*, not in lambda, and would not be.
    const [low, high] = eventLeverageBand(wad('0.0370'), wad('3.402'), wad('0.399'));
    expect(low.raw).toBe(whole(10).raw);
    expect(high.raw).toBe(whole(13).raw);
    expect(absDiff(whole(11), low)).toBe(10n ** 18n);
    expect(absDiff(high, whole(11))).toBe(2n * 10n ** 18n);
  });

  it('refuses a standard error at or above the multiplier', () => {
    // At equality the low end is a division by zero, and below it the lower leverage is negative.
    expect(() => eventLeverageBand(wad('0.037'), wad('1'), wad('1'))).toThrow(/larger than/);
    expect(() => eventLeverageBand(wad('0.037'), wad('1'), wad('2'))).toThrow(ShrinkageError);
  });

  it('refuses a negative standard error', () => {
    expect(() => eventLeverageBand(wad('0.037'), wad('3.402'), Wad.fromWhole(-1n))).toThrow(
      /cannot be negative/,
    );
  });
});
