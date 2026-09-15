/**
 * The value objects' invariants and arithmetic, at unit level.
 *
 * Ported from `calibrator/tests/unit/test_models.py`, whose own header states why it exists:
 * `models.py` had no unit test file, its value objects are constructed all over the suite so the
 * *happy* path was exercised everywhere, and what was missing was the other half — six validation
 * guards that had never fired and three methods that nothing called at all. A guard that has never
 * been observed to fire is indistinguishable from one that does nothing.
 *
 * Three things about the mapping, each stated rather than left to be noticed.
 *
 *  - **The Python's 17 tests arrive as 15 here and 2 in `bytes.test.ts`,** because `NameId` lives in
 *    `bytes.ts` now. The test file mirrors the source file, which is the same reason those two files
 *    were split.
 *  - **Five tests from `test_sessions.py` are absorbed here**, which `sessions.test.ts` deferred to
 *    this file by name: its `TestDailyBar` (3) and `TestSymbol` (2) classes exercise `models`, not
 *    `sessions`. All five are **subsumed rather than copied**, and strictly — the refusal set here
 *    adds `-NVDA` and the gap test here adds a flat bar and a negative close, which are the cases the
 *    copies in `test_sessions.py` do not reach. Each is named at the assertion that covers it.
 *  - **One test is an addition.** The Python's `Wad` is a `@dataclass(order=True)`, so it gets a total
 *    order and `sorted()` for free. The port has no `compareTo`, so every sort site orders on `raw`
 *    with an explicit comparator; that test pins the ordering the port does have.
 *
 * The API differences the port forces, so that a reader comparing the two files knows which
 * differences are deliberate:
 *
 *  - `Wad`'s operators are methods — `add`, `sub`, `mul`, `negate` — because a `Wad` cannot be added
 *    to a `bigint` and a `number` cannot reach the type at all. That is what makes a unit error
 *    unwritable, and it is why there is no `+` to translate.
 *  - `Wad.toDecimalString()` replaces `to_decimal()`. The claim is the same — the conversion loses
 *    nothing — and it is asserted the same way, against `raw / WAD` computed here rather than against
 *    a literal. Nothing in the port needs a `Decimal` back; a caller that does writes
 *    `new D(wad.toDecimalString())`.
 *  - `DailyBar` takes its date as an ISO `string` and `ParameterSet` takes one options object rather
 *    than six positional fields, which is why the Python's `_parameters(**overrides)` helper becomes
 *    a spread here and needs no `type: ignore`.
 */

import { describe, expect, it } from 'vitest';

import { WAD } from '../../src/domain/constants.js';
import { D } from '../../src/domain/moments.js';
import {
  type Calibrated,
  type CalibrationResult,
  DailyBar,
  type InsufficientSample,
  ParameterSet,
  SessionKind,
  Symbol,
  Wad,
} from '../../src/domain/models.js';

/** The field list `ParameterSet` takes, so a test can vary one field and leave the rest valid. */
type ParameterFields = ConstructorParameters<typeof ParameterSet>[0];

/** A valid `ParameterSet`, with named fields overridable so each test varies one thing. */
function parameters(overrides: Partial<ParameterFields> = {}): ParameterSet {
  return new ParameterSet({
    symbol: new Symbol('NVDA'),
    session: SessionKind.OVERNIGHT,
    lam: Wad.fromWhole(15n),
    premium: Wad.fromRaw(174n * 10n ** 15n),
    inputsHash: new Uint8Array(32).fill(0x11),
    model: 'empirical',
    ...overrides,
  });
}

describe('Wad', () => {
  it('refuses a decimal with more places than the scale can hold', () => {
    // More than 18 decimal places cannot survive the scaling, and truncating silently would make the
    // type's claim to exactness false. Refused *before* the multiply, which is the difference from the
    // Python: it multiplies in `decimal`'s ambient context and its integrality check then passes on a
    // rounded result, so for a long literal it accepts a value that is wrong in its last eight digits
    // (F60).
    expect(() => Wad.fromDecimal(new D('0.0000000000000000001'))).toThrow(
      /not exactly representable/,
    );
  });

  it('accepts the full eighteen places', () => {
    // The boundary: the smallest representable increment is accepted.
    expect(Wad.fromDecimal(new D('0.000000000000000001')).raw).toBe(1n);
  });

  it('round-trips through its decimal string exactly', () => {
    // `toDecimalString` is the lossless way back, and it is what a report or a log would use. Asserted
    // against `raw / WAD` computed here rather than against five literals, so the test states the
    // conversion's contract instead of restating its output.
    for (const raw of [0n, 1n, 174n * 10n ** 15n, 15n * 10n ** 18n, WAD]) {
      const exact = new D(raw.toString()).div(new D(WAD.toString()));
      expect(new D(Wad.fromRaw(raw).toDecimalString()).equals(exact), `${String(raw)} wei`).toBe(
        true,
      );
    }
    expect(Wad.fromStr('0.0188').toDecimalString()).toBe('0.0188');
  });

  it('is fixed-point arithmetic, and every operator agrees on the scale', () => {
    // Pinned together because they are one contract: a caller may mix them, and the only way `Wad`
    // keeps a unit error unwritable is if every operator agrees on the scale.
    expect(Wad.fromWhole(3n).add(Wad.fromWhole(2n)).raw, 'addition is exact on the raw scale').toBe(
      5n * 10n ** 18n,
    );
    expect(Wad.fromWhole(3n).sub(Wad.fromWhole(5n)).raw, 'subtraction can go negative').toBe(
      -2n * 10n ** 18n,
    );
    expect(Wad.fromWhole(2n).negate().raw, 'negation is exact').toBe(-2n * 10n ** 18n);
    expect(Wad.fromWhole(2n).mul(Wad.fromWhole(3n)).raw, 'WAD multiplication').toBe(
      6n * 10n ** 18n,
    );
    expect(Wad.fromRaw(5n * 10n ** 17n).mul(Wad.fromWhole(4n)).raw, 'one half times four').toBe(
      2n * 10n ** 18n,
    );
    expect(Wad.fromRaw(1n).mul(Wad.fromRaw(1n)).raw, 'and it truncates toward zero').toBe(0n);
  });

  it('is ordered', () => {
    // Ordering is relied on wherever a quantile is taken: a quantile over an unordered type returns an
    // arbitrary element rather than a rank. The Python gets this from `@dataclass(order=True)`; here it
    // is the four comparison methods.
    expect(Wad.fromWhole(1n).lessThan(Wad.fromWhole(2n))).toBe(true);
    expect(Wad.fromWhole(2n).greaterThanOrEqual(Wad.fromWhole(2n))).toBe(true);
    expect(Wad.fromWhole(2n).greaterThan(Wad.fromWhole(2n))).toBe(false);
    expect(Wad.fromWhole(2n).lessThanOrEqual(Wad.fromWhole(2n))).toBe(true);
    expect(Wad.fromWhole(2n).equals(Wad.fromWhole(2n))).toBe(true);
  });

  it('has no total order of its own, so every sort site supplies one', () => {
    // The one test here with no Python counterpart. `sorted()` on the Python's `Wad` works because the
    // dataclass is `order=True`; the port has no `compareTo`, and `leverage.ts` and `families/base.ts`
    // each order on `raw` with an explicit comparator. The comparator is not optional in practice —
    // `@typescript-eslint/require-array-sort-compare` is on, and it refuses `sort()` on a `bigint[]`
    // without one, which is the enforcement this test documents the need for.
    const ascending = (left: bigint, right: bigint): number => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    };
    const gaps = [Wad.fromRaw(3n), Wad.fromRaw(1n), Wad.fromRaw(2n)];
    expect(gaps.map((gap) => gap.raw).sort(ascending)).toEqual([1n, 2n, 3n]);
  });

  it('renders a negative value with its sign, whole and fractional', () => {
    // `toDecimalString` is the only way a `Wad` becomes text, so a sign lost here is a sign lost in
    // every report and every log that reads one. **Both spellings are asserted, and the two are not
    // redundant:** the sign is written twice in the source — once in the integer branch and once in
    // the fractional one — so a test that reached only one would leave the other free to drop it.
    // Found by asking which branch of the value type's own formatter no test had taken, rather than
    // by reading it: the branch report said the `negative` conjunct had never been true at all.
    expect(Wad.fromWhole(-3n).toDecimalString(), 'whole, no fraction').toBe('-3');
    expect(Wad.fromStr('-0.0188').toDecimalString(), 'whole and fraction').toBe('-0.0188');
    expect(Wad.fromRaw(-1n).toDecimalString(), 'the smallest increment, negative').toBe(
      '-0.000000000000000001',
    );
  });

  it('has a unit, a zero test, a sign test and a magnitude', () => {
    // **Four members of the value type's public surface that nothing in the port called.** The branch
    // report showed `Wad.one` never evaluated and `isZero`, `isNegative` and `abs` never invoked at
    // all — `abs`'s conditional was entered zero times, which is what an uncalled function looks like
    // from the inside.
    //
    // They are asserted rather than deleted. `Wad` is the port's translation of the Python's `Wad`,
    // and a member of that type's surface is a claim about the type; a claim no test has ever
    // evaluated is a claim nobody has checked. `Wad.one` is the case that makes it more than
    // bookkeeping — the Python's `Wad(1)` is the multiplicative identity every caller gets for free,
    // and here it is the only way to write one that is not `fromWhole(1n)`.
    expect(Wad.one.raw, 'the unit at WAD scale').toBe(WAD);
    expect(Wad.fromWhole(3n).mul(Wad.one).equals(Wad.fromWhole(3n)), 'and it is the identity').toBe(
      true,
    );

    expect(Wad.zero.isZero(), 'zero').toBe(true);
    expect(Wad.fromRaw(1n).isZero(), 'one wei').toBe(false);

    expect(Wad.fromRaw(-1n).isNegative(), 'negative').toBe(true);
    expect(Wad.fromRaw(1n).isNegative(), 'positive').toBe(false);

    // Three arms of one conditional, because the sign test inside it is what decides whether the
    // magnitude is a negation — and `zero` is the arm a two-case test would miss.
    expect(Wad.fromWhole(-3n).abs().raw, 'negative').toBe(3n * 10n ** 18n);
    expect(Wad.fromWhole(3n).abs().raw, 'positive').toBe(3n * 10n ** 18n);
    expect(Wad.zero.abs().raw, 'zero').toBe(0n);
  });

  it('refuses a value that cannot be scaled exactly, including a non-finite one', () => {
    // The integrality check is the second of the two guards, and the first cannot cover a non-finite
    // value: `decimalPlaces()` on `Infinity` is `NaN`, so the `isFinite` conjunct skips the
    // decimal-places guard and the value falls through to here. That is the path `fromDecimal`'s own
    // docstring names — "a non-finite value falls through to the integrality check rather than to a
    // check of its own" — and until this test nothing took it. The branch report agreed: the guard
    // was reached 45 times and its consequent never once.
    expect(() => Wad.fromDecimal(new D(Number.POSITIVE_INFINITY))).toThrow(
      /not exactly representable/,
    );
    expect(() => Wad.fromDecimal(new D(Number.NEGATIVE_INFINITY))).toThrow(
      /not exactly representable/,
    );
  });
});

describe('Symbol', () => {
  // `Symbol` shadows the JavaScript global of that name for the rest of this module. Nothing here needs
  // the global, and the collision is the port's rather than the Python's — Python has no `Symbol`
  // builtin — which is why it is named once rather than left to surprise a reader (F78).
  it('accepts a canonical ticker', () => {
    // `A` and `ABCDEFGHIJ` are the length boundaries, and `BRK.B` is the only dotted form in use.
    // `test_sessions.py`'s copy of this test uses four four-letter tickers instead, which test less.
    for (const text of ['NVDA', 'BRK.B', 'A', 'ABCDEFGHIJ']) {
      expect(new Symbol(text).text).toBe(text);
    }
  });

  it('refuses anything that is not a canonical ticker', () => {
    // A `string` would make this validation optional, which is the same as absent. `-NVDA` is the case
    // the pattern's `^[A-Z]` is there to reject, and `test_sessions.py`'s copy omits it.
    for (const text of ['nvda', '1NVDA', '', 'TOOLONGTICKER', 'NV DA', '-NVDA']) {
      expect(() => new Symbol(text)).toThrow(/not a canonical ticker/);
    }
  });
});

describe('ParameterSet', () => {
  it('accepts a priceable parameter', () => {
    const fields = parameters();
    expect(fields.lam.raw).toBe(15n * 10n ** 18n);
    expect(fields.model).toBe('empirical');
  });

  it('refuses an inputs hash that is not 32 bytes', () => {
    // The inputs hash is the key a challenge re-runs the fit from, so a truncated one would make the
    // re-run impossible while still looking like a commitment.
    //
    // **The over-long case is an addition.** The Python tests only the short side, and the guard is
    // `!= 32` rather than `< 32` — so a `33`-byte hash was refused by code no test reached. Found by
    // asking which break the suite would *not* catch: weakening the guard to `< DIGEST_BYTES` left
    // every test green (`.recon/a8/probe.py`, `inputs_hash_lower_bound_only`). The same one-sided gap
    // existed for `rowsDigest` in `digest.test.ts`, and the probe found that one too.
    expect(() => parameters({ inputsHash: new Uint8Array(31) })).toThrow(
      /an inputs hash is 32 bytes/,
    );
    expect(() => parameters({ inputsHash: new Uint8Array(33) })).toThrow(
      /an inputs hash is 32 bytes/,
    );
  });

  it('refuses a non-positive leverage', () => {
    // A zero leverage makes the saturation cap infinite, which is not a contract that can be listed —
    // the lattice gate refuses it on chain, and this refuses it before publication.
    expect(() => parameters({ lam: Wad.zero })).toThrow(/a leverage of zero is not priceable/);
    expect(() => parameters({ lam: Wad.fromRaw(-1n) })).toThrow(
      /a leverage of zero is not priceable/,
    );
  });

  it('refuses a premium outside the unit interval', () => {
    // A premium at or below zero is a free claim; one above the collateral unit would promise more
    // than the pair can pay.
    expect(() => parameters({ premium: Wad.zero })).toThrow(/a premium outside/);
    expect(() => parameters({ premium: Wad.fromRaw(WAD + 1n) })).toThrow(/a premium outside/);
  });

  it('accepts the boundary premium', () => {
    // The interval is `(0, 1]`, so a premium of exactly the collateral unit is allowed.
    expect(parameters({ premium: Wad.fromRaw(WAD) }).premium.raw).toBe(WAD);
  });
});

describe('DailyBar', () => {
  it('gap is the signed close-to-open return', () => {
    // `G = O / C_prev - 1`, signed. The magnitude is a volatility quantity and the sign is
    // directional, so both directions must come out with the right sign. The flat bar is a case
    // `test_sessions.py`'s copy of this test does not reach.
    const up = new DailyBar('2026-01-02', Wad.fromWhole(100n), Wad.fromWhole(102n));
    const down = new DailyBar('2026-01-02', Wad.fromWhole(100n), Wad.fromWhole(98n));
    const flat = new DailyBar('2026-01-02', Wad.fromWhole(100n), Wad.fromWhole(100n));

    expect(up.gap().raw, '+2%').toBe(2n * 10n ** 16n);
    expect(down.gap().raw, '-2%').toBe(-2n * 10n ** 16n);
    expect(flat.gap().raw, 'flat').toBe(0n);
  });

  it('refuses a non-positive close', () => {
    // A close of zero has no ratio, and the division would raise a less specific error.
    //
    // The guard is in `gap()` rather than in the constructor: a bar with a zero close is representable,
    // it simply cannot form a gap, and refusing it at construction would reject a datum the adapter may
    // legitimately have read. The negative close is the case `test_sessions.py`'s copy does not reach.
    expect(() => new DailyBar('2026-01-02', Wad.zero, Wad.fromWhole(100n)).gap()).toThrow(
      /a close must be positive/,
    );
    expect(() => new DailyBar('2026-01-02', Wad.fromRaw(-1n), Wad.fromWhole(100n)).gap()).toThrow(
      /a close must be positive/,
    );
  });
});

describe('the calibration result', () => {
  it('is a two-case union a caller branches on rather than catching', () => {
    // A domain result rather than an exception: "the sample cannot place a quantile" is an expected
    // outcome of the leverage rule, so a caller branches rather than catching. The Python asserts
    // `isinstance` on both cases; here both members are assignable to the union and the discriminant
    // is what a caller switches on, which is the stronger claim — the compiler refuses the other
    // branch, and a third case would fail to compile at every site that switches.
    const calibrated: Calibrated = { kind: 'calibrated', parameters: parameters() };
    const insufficient: InsufficientSample = {
      kind: 'insufficient',
      symbol: new Symbol('NVDA'),
      session: SessionKind.OVERNIGHT,
      observations: 10,
      requiredTailObservations: 20,
    };

    const results: CalibrationResult[] = [calibrated, insufficient];
    expect(results.map((result) => result.kind)).toEqual(['calibrated', 'insufficient']);
    expect(insufficient.observations).toBeLessThan(insufficient.requiredTailObservations);
  });
});
