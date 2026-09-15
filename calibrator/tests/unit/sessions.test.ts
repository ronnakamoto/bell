/**
 * Unit tests for session classification and the estimability screen.
 *
 * Ported from `calibrator/tests/unit/test_sessions.py`, which has **11** tests in five classes; this file
 * has 6. Three departures, each stated rather than silent:
 *
 *  - **The `TestDailyBar` and `TestSymbol` classes are not ported here**, which is **5 of the 11**. They
 *    exercise `models.py`, not `sessions.py`, and they duplicate tests that already exist in
 *    `test_models.py` — where the versions are strictly stronger. That file's refusal set includes
 *    `-NVDA` (the leading-dash case the pattern's `^[A-Z]` is there to reject) and its gap test covers
 *    the flat bar and a negative close; `test_sessions.py` covers neither. Its acceptance set is also
 *    the better chosen one: `A` and `ABCDEFGHIJ` are the length boundaries, where `TSLA` and `AAPL` are
 *    two more four-letter tickers. So the copies here would add no coverage, and they belong in
 *    `models.test.ts`, which tracker item A8 creates from `test_models.py`. Verified by reading both
 *    files rather than by assuming the newer one was weaker.
 *
 *    **A8 has now done that**, and confirmed it: all five are subsumed, and `models.test.ts` names which
 *    assertion covers each. So no test was lost, and the count that said otherwise — "10 tests in five
 *    classes", "4 of the 10" — was wrong in both numbers while the conclusion drawn from it was right.
 *    Corrected here rather than left, because a header that miscounts is how the next reader concludes a
 *    test is missing when it is not, or present when it is not (F79).
 *  - **`SessionSpan` is constructed with an options object**, `new SessionSpan({ calendarDays: 1 })`,
 *    where the Python passes positionally. It carries a defaulted second field, which is what an
 *    options object is for, and it is the shape `ParameterSet` already uses.
 *  - **The tail-observation comparison uses a tolerance, and the tolerance is load-bearing.** The
 *    Python asserts `pytest.approx(tail, abs=0.01)`; this asserts to two decimal places. Neither can
 *    be replaced by an equality check: `1965 * 0.01` is `19.650000000000002`, not `19.65`, in Python
 *    and in JavaScript alike — verified in both before writing this. That is the only place in the
 *    port where a value is a `number` rather than an exact integer, and it is why `sessions.ts` says
 *    so at the definition.
 */

import { describe, expect, it } from 'vitest';

import { SessionKind } from '../../src/domain/models.js';
import {
  classify,
  expectedTailObservations,
  isPooledWithWeekend,
  SessionSpan,
} from '../../src/domain/sessions.js';

describe('session classification', () => {
  it('maps spans to the taxonomy', () => {
    expect(classify(new SessionSpan({ calendarDays: 1 }))).toBe(SessionKind.OVERNIGHT);
    expect(classify(new SessionSpan({ calendarDays: 3 }))).toBe(SessionKind.WEEKEND);
    expect(classify(new SessionSpan({ calendarDays: 2 }))).toBe(SessionKind.HOLIDAY);
    expect(classify(new SessionSpan({ calendarDays: 4 }))).toBe(SessionKind.HOLIDAY);
    expect(classify(new SessionSpan({ calendarDays: 5 }))).toBe(SessionKind.HOLIDAY);
  });

  it('lets an announcement short-circuit the span', () => {
    // The ordering is the whole point: an announcement gap is Overnight by duration and a different
    // object by distribution, so a rule that tested the span first would pool it with the overnight
    // sample and understate the premium by 4.0 to 16.5% (paper §7.10).
    const span = new SessionSpan({ calendarDays: 1, containsScheduledAnnouncement: true });
    expect(classify(span)).toBe(SessionKind.EVENT);
  });

  it('treats an announcement on a weekend span as an event', () => {
    const span = new SessionSpan({ calendarDays: 3, containsScheduledAnnouncement: true });
    expect(classify(span)).toBe(SessionKind.EVENT);
  });

  it('refuses a sub-day span', () => {
    expect(() => new SessionSpan({ calendarDays: 0 })).toThrow(/at least one calendar day/);
  });
});

describe('pooling', () => {
  it('makes only overnight per-name', () => {
    expect(isPooledWithWeekend(SessionKind.OVERNIGHT)).toBe(false);
    expect(isPooledWithWeekend(SessionKind.WEEKEND)).toBe(true);
    expect(isPooledWithWeekend(SessionKind.HOLIDAY)).toBe(true);
    expect(isPooledWithWeekend(SessionKind.EVENT)).toBe(true);
  });
});

describe('the tail-observation screen', () => {
  it("reproduces the paper's Table 14", () => {
    // The governing quantity is the expected count at or beyond the 99th percentile, not the sample
    // size: 19.65 overnight, 4.52 on a weekend, 0.96 on a holiday, 0.34 in an event session.
    // Everything else in the paper's Table 14 follows from this column.
    const expected = new Map([
      [1965, 19.65],
      [452, 4.52],
      [96, 0.96],
      [34, 0.34],
    ]);
    for (const [observations, tail] of expected) {
      expect(expectedTailObservations(observations, 0.01)).toBeCloseTo(tail, 2);
    }
  });
});
