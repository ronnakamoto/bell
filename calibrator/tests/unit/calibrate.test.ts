/**
 * The calibration use case.
 *
 * The use case is tested against literal bars rather than a fixture, because that is the test the
 * brief applies for whether something belongs in the application layer: it sequences the domain's
 * pieces and touches nothing, so it is callable with arguments.
 *
 * Ported from `calibrator/tests/unit/test_calibrate.py`, which has 18 tests in four classes; this file
 * has more, and the additions are marked. Departures, each stated rather than silent:
 *
 *  - **The reference keccak is `@noble/hashes`**, where the Python uses `Crypto.Hash.keccak`. Same
 *    primitive; `digest.test.ts` established the convention.
 *  - **`barsFromGaps` builds ISO date strings**, where the Python builds `date` objects from
 *    `date(2020, 1, 6) + timedelta(days=index)`. The dates only have to be distinct and valid — every
 *    digest assertion compares one digest against another rather than against a constant — so the
 *    generator below uses `Date.UTC` as an implementation *independent of* `dateOrdinal`, which is
 *    what keeps the ordinal tests non-circular.
 *  - **The seven added tests are all about the one thing the Python got from its standard library.**
 *    `rows_digest` hashes `date.toordinal()` into four bytes; the port's `DailyBar` holds a string, so
 *    `dateOrdinal` is a function the port has to write and therefore a function the port has to test.
 *    The Python could not have a test for it — there was nothing of its own to test.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  CalibrationError,
  CalibrationRequest,
  calibrate,
  dateOrdinal,
  rowsDigest,
  windowFor,
} from '../../src/application/calibrate.js';
import { WAD } from '../../src/domain/constants.js';
import { type DistributionFamily, FAMILIES } from '../../src/domain/families/index.js';
import { isOnHarmonicLadder } from '../../src/domain/leverage.js';
import { DailyBar, SessionKind, Symbol, Wad } from '../../src/domain/models.js';
import { type Keccak } from '../../src/domain/ports.js';

const NVDA = new Symbol('NVDA');
const SOURCE_IDS: readonly string[] = ['test-fixture'];

const referenceKeccak: Keccak = (data) => keccak_256(data);

/** `FAMILIES[name]`, which the Python indexes directly and a `Map` cannot. */
function familyNamed(name: string): DistributionFamily {
  const found = FAMILIES.get(name);
  if (found === undefined) throw new Error(`no family registered as '${name}'`);
  return found;
}

/** `date(2020, 1, 6) + timedelta(days=offset)`, through an implementation `dateOrdinal` does not share. */
function isoDateFrom(startIso: string, offset: number): string {
  const base = Date.UTC(
    Number(startIso.slice(0, 4)),
    Number(startIso.slice(5, 7)) - 1,
    Number(startIso.slice(8, 10)),
  );
  return new Date(base + offset * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A bar series whose gaps are exactly the ones given.
 *
 * The close is held at 100 and the next open is set from the gap, so a gap of `0.02` is a bar with
 * `next_open = 102`. Holding the close constant keeps the series easy to reason about and makes the
 * gap the only thing a test has to state.
 *
 * `int(Decimal(gap) * WAD)` **truncates** in the Python, so this truncates rather than rounding.
 * Every gap the tests use gives an exact product, which is exactly why the difference would go
 * unnoticed if it were wrong — see the sigma test in `families.test.ts` for the same trap.
 */
function barsFromGaps(gaps: readonly string[], start = '2020-01-06'): DailyBar[] {
  return gaps.map((gap, index) => {
    const move = BigInt(new Decimal(gap).times(WAD.toString()).trunc().toFixed(0));
    return new DailyBar(
      isoDateFrom(start, index),
      new Wad(100n * WAD),
      new Wad(100n * WAD + move * 100n),
    );
  });
}

function request(window: number): CalibrationRequest {
  return new CalibrationRequest({
    symbol: NVDA,
    session: SessionKind.OVERNIGHT,
    windowSessions: window,
    sourceIds: SOURCE_IDS,
  });
}

describe('the window', () => {
  it('the overnight window is the published one', () => {
    expect(windowFor(SessionKind.OVERNIGHT, NVDA)).toBe(504);
  });

  it('AAPL is the one per-name exception', () => {
    // The paper records a 378-session overnight window for AAPL against 504 for the others.
    expect(windowFor(SessionKind.OVERNIGHT, new Symbol('AAPL'))).toBe(378);
  });

  it('the weekend and holiday share a window', () => {
    expect(windowFor(SessionKind.WEEKEND, NVDA)).toBe(windowFor(SessionKind.HOLIDAY, NVDA));
    expect(windowFor(SessionKind.WEEKEND, NVDA)).toBe(126);
  });

  it('an event session has no pooled window', () => {
    // The event session is calibrated per name with a pooled shape and a shrunk scale, which is not a
    // window and must not be answered with one.
    expect(() => windowFor(SessionKind.EVENT, NVDA)).toThrow(/per name/);
  });

  it('names the session by its code, as the Python does', () => {
    // `StrEnum` formats as its value, so the oracle's message reads "the C session has no pooled
    // window". A port that printed `SessionKind.EVENT` would still match `/per name/` and would still
    // be a different message from the one the Python emits.
    expect(() => windowFor(SessionKind.EVENT, NVDA)).toThrow(/the C session has no pooled window/);
  });

  it('refuses with a named error type', () => {
    // Added by the port. The Python raises `ValueError` here, `ValueError` for a bad request, and
    // `ValueError` from a dozen other places, so a caller cannot branch on it. The port names the
    // type, and the name is what the adapter layer branches on.
    expect(() => windowFor(SessionKind.EVENT, NVDA)).toThrow(CalibrationError);
  });
});

describe('calibration', () => {
  it('a sufficient sample produces a parameter set', () => {
    const bars = barsFromGaps(Array.from({ length: 600 }, () => '0.01'));
    const result = calibrate(request(600), bars, familyNamed('empirical'), referenceKeccak);
    expect(result.kind).toBe('calibrated');
    if (result.kind !== 'calibrated') throw new Error('unreachable');
    expect(result.parameters.symbol.equals(NVDA)).toBe(true);
    expect(result.parameters.session).toBe(SessionKind.OVERNIGHT);
    expect(result.parameters.model).toBe('empirical');
  });

  it('the leverage is a whole number', () => {
    // The lattice gate refuses an off-lattice leverage, so a calibrator that produced one would
    // publish a parameter set the factory could not list.
    const bars = barsFromGaps(Array.from({ length: 600 }, () => '0.01'));
    const result = calibrate(request(600), bars, familyNamed('empirical'), referenceKeccak);
    if (result.kind !== 'calibrated') throw new Error('expected a calibration');
    expect(isOnHarmonicLadder(result.parameters.lam)).toBe(true);
  });

  it('a constant series gives a leverage above one', () => {
    // Every gap is 1%, so the 99th percentile is 1% and the leverage is about 100.
    const bars = barsFromGaps(Array.from({ length: 600 }, () => '0.01'));
    const result = calibrate(request(600), bars, familyNamed('empirical'), referenceKeccak);
    if (result.kind !== 'calibrated') throw new Error('expected a calibration');
    expect(result.parameters.lam.raw / WAD).toBeGreaterThanOrEqual(2n);
  });

  it('a short series is an insufficient sample', () => {
    const bars = barsFromGaps(Array.from({ length: 10 }, () => '0.01'));
    const result = calibrate(request(504), bars, familyNamed('empirical'), referenceKeccak);
    expect(result.kind).toBe('insufficient');
    if (result.kind !== 'insufficient') throw new Error('unreachable');
    expect(result.observations).toBe(10);
    expect(result.requiredTailObservations).toBe(504);
  });

  it('the tail screen fires below one tail observation', () => {
    // The screen is on the *tail count*, not the sample size, and this is what makes holidays pooled:
    // a 96-observation holiday window holds 0.96 tail observations at alpha = 1%, which is not enough
    // to place a quantile. The window is supplied, so the screen is the only thing standing between a
    // 96-session window and a published leverage.
    const bars = barsFromGaps(Array.from({ length: 96 }, () => '0.01'));
    const result = calibrate(request(96), bars, familyNamed('empirical'), referenceKeccak);
    expect(result.kind).toBe('insufficient');
  });

  it('a hundred observations clears the screen', () => {
    // Exactly one tail observation, which is the boundary and is admitted.
    const bars = barsFromGaps(Array.from({ length: 100 }, () => '0.01'));
    const result = calibrate(request(100), bars, familyNamed('empirical'), referenceKeccak);
    expect(result.kind).toBe('calibrated');
  });

  it('the window is taken from the end of the series', () => {
    // A parameter set is committed before the session it describes opens, so the only observations
    // available are the ones behind it. Taking the head would calibrate on the oldest data.
    const bars = barsFromGaps([
      ...Array.from({ length: 100 }, () => '0.001'),
      ...Array.from({ length: 100 }, () => '0.05'),
    ]);
    const result = calibrate(request(100), bars, familyNamed('empirical'), referenceKeccak);
    if (result.kind !== 'calibrated') throw new Error('expected a calibration');
    // The recent 5% gaps give a 99th percentile of 5%, so the leverage is about 20, not the hundreds
    // a 0.1% window would give.
    expect(result.parameters.lam.raw / WAD).toBeLessThan(50n);
  });

  it('the Gaussian and the empirical disagree', () => {
    // Two families, one use case: the family is a parameter of the calibration, not of the pipeline,
    // which is what makes the comparison reproducible.
    const bars = barsFromGaps([
      ...Array.from({ length: 590 }, () => '0.001'),
      ...Array.from({ length: 10 }, () => '0.08'),
    ]);
    const empirical = calibrate(request(600), bars, familyNamed('empirical'), referenceKeccak);
    const gaussian = calibrate(request(600), bars, familyNamed('gaussian'), referenceKeccak);
    if (empirical.kind !== 'calibrated') throw new Error('expected a calibration');
    if (gaussian.kind !== 'calibrated') throw new Error('expected a calibration');
    expect(empirical.parameters.premium.raw).not.toBe(gaussian.parameters.premium.raw);
    expect(gaussian.parameters.model).toBe('gaussian');
  });
});

describe('the inputs hash', () => {
  it('the digest is deterministic', () => {
    const bars = barsFromGaps(Array.from({ length: 600 }, () => '0.01'));
    const first = calibrate(request(600), bars, familyNamed('empirical'), referenceKeccak);
    const second = calibrate(request(600), bars, familyNamed('empirical'), referenceKeccak);
    if (first.kind !== 'calibrated') throw new Error('expected a calibration');
    if (second.kind !== 'calibrated') throw new Error('expected a calibration');
    expect(first.parameters.inputsHash).toEqual(second.parameters.inputsHash);
  });

  it('the digest is sensitive to the rows', () => {
    const first = rowsDigest(referenceKeccak, barsFromGaps(['0.01', '0.02']));
    const second = rowsDigest(referenceKeccak, barsFromGaps(['0.01', '0.03']));
    expect(first).not.toEqual(second);
  });

  it('the digest is sensitive to the order of the rows', () => {
    // The canonical serialisation is positional, so a reordered window is a different input set. That
    // matters because the window is defined as the last N sessions, and a source that reordered would
    // otherwise produce the same digest for a different fit.
    const forward = barsFromGaps(['0.01', '0.02']);
    const reversed = [...forward].reverse();
    expect(rowsDigest(referenceKeccak, forward)).not.toEqual(rowsDigest(referenceKeccak, reversed));
  });

  it('the digest is sensitive to the close', () => {
    // The digest covers the close as well as the open, because the gap is a ratio and a series scaled
    // by a constant has the same gaps and different rows.
    const bars = barsFromGaps(['0.01']);
    const scaled = bars.map(
      (bar) =>
        new DailyBar(bar.tradingDate, new Wad(bar.close.raw * 2n), new Wad(bar.nextOpen.raw * 2n)),
    );
    expect(rowsDigest(referenceKeccak, bars)).not.toEqual(rowsDigest(referenceKeccak, scaled));
  });
});

describe('the request', () => {
  it('a zero window is refused', () => {
    expect(
      () =>
        new CalibrationRequest({
          symbol: NVDA,
          session: SessionKind.OVERNIGHT,
          windowSessions: 0,
          sourceIds: SOURCE_IDS,
        }),
    ).toThrow(/at least one session/);
  });

  it('a request with no sources is refused', () => {
    // A parameter set has to name the sources its inputs came from, or a challenge cannot reconstruct
    // the input set it is meant to verify.
    expect(
      () =>
        new CalibrationRequest({
          symbol: NVDA,
          session: SessionKind.OVERNIGHT,
          windowSessions: 504,
          sourceIds: [],
        }),
    ).toThrow(/sources/);
  });
});

describe('the date ordinal', () => {
  // The expected values are Python's `date(y, m, d).toordinal()`, printed rather than derived, so the
  // assertion is against the oracle rather than against a second implementation of the same formula.
  it('matches the proleptic Gregorian ordinals Python produces', () => {
    expect(dateOrdinal('0001-01-01')).toBe(1);
    expect(dateOrdinal('1970-01-01')).toBe(719163);
    expect(dateOrdinal('2020-01-06')).toBe(737430);
    expect(dateOrdinal('2024-02-29')).toBe(738945);
    expect(dateOrdinal('9999-12-31')).toBe(3652059);
  });

  it('counts the century rule rather than every fourth year', () => {
    // 1900 is not a leap year and 2000 is, which is the case a `year % 4` shortcut gets wrong. Both
    // expectations are Python's `toordinal()`, and their difference is the 365 days of 1900 plus the
    // 28,227 days to 2000-03-01.
    expect(dateOrdinal('1900-03-01') - dateOrdinal('1900-02-28')).toBe(1);
    expect(dateOrdinal('2000-03-01') - dateOrdinal('2000-02-29')).toBe(1);
  });

  it('refuses a string that is not an ISO 8601 calendar date', () => {
    expect(() => dateOrdinal('garbage')).toThrow(/not an ISO 8601 calendar date/);
  });

  it('refuses a month outside 1..12', () => {
    expect(() => dateOrdinal('2020-13-01')).toThrow(/month must be in 1\.\.12/);
  });

  it('refuses a day outside the month', () => {
    expect(() => dateOrdinal('2020-02-30')).toThrow(/day is out of range/);
  });

  it('refuses a 29 February that is not in a leap year', () => {
    expect(() => dateOrdinal('1900-02-29')).toThrow(/day is out of range/);
  });

  it('refuses a year zero, which Python date does too', () => {
    expect(() => dateOrdinal('0000-01-01')).toThrow(/year 0 is out of range/);
  });

  it('narrows the accepted forms to YYYY-MM-DD', () => {
    // `date.fromisoformat` also accepts these three, and the port deliberately does not: only
    // `YYYY-MM-DD` is reachable from the CSV adapter, and a second grammar whose disagreement would be
    // silent is worse than a loud refusal. Stated here so the narrowing is a test rather than a
    // comment.
    expect(() => dateOrdinal('20200106')).toThrow(/expected YYYY-MM-DD/);
    expect(() => dateOrdinal('2020-W02-1')).toThrow(/expected YYYY-MM-DD/);
    expect(() => dateOrdinal('2020-006')).toThrow(/expected YYYY-MM-DD/);
  });
});
