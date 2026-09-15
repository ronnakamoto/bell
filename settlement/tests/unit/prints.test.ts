/**
 * The reference print selection.
 *
 * Ported from `settlement/tests/unit/test_prints.py`, which has 16 tests; this file has 18. Two
 * additions, each stated rather than silent:
 *
 *  - **`priority outranks the timestamp`.** The Python tests priority at *equal* timestamps and
 *    timestamps at *equal* priority, so the precedence between the two is never exercised: a
 *    candidate with the lower priority and the *earlier* timestamp is the case neither of its tests
 *    can reach. It is the first clause of `outranks`, i.e. the one that decides most real books.
 *  - **`a print exactly at the staleness bound still qualifies`.** The Python asserts a print one
 *    second *beyond* the bound and never one *at* it, so `<=` and `<` are indistinguishable under its
 *    suite. `test_routes.py` even names the hazard in a comment — "a print exactly at the bound still
 *    qualifies, so a test using it would silently settle instead" — and then does not assert it. The
 *    bound is `<=` here, which is the direction that settles rather than defers, so it is worth
 *    pinning.
 *
 * **Two departures, both forced by the time representation.**
 *
 *  - A timestamp is a `bigint` count of Unix seconds, where the Python's is a `datetime`. `EXPIRY` is
 *    therefore the literal `1789392600` — `2026-09-14T13:30:00Z` — and the bounds are `600n` and
 *    `7200n`. The literal was read off CPython's `int(datetime(2026, 9, 14, 13, 30, tzinfo=UTC)
 *    .timestamp())` and cross-checked against `Date.parse`, rather than computed here; nothing in
 *    this file converts a date, so nothing in it can disagree about one.
 *  - `printAt` takes its options as one object, where the Python's are keyword-only arguments. Same
 *    reason as the port's: four positional arguments of one type are a signature in which a swap
 *    compiles.
 *
 * The ordering is asserted rather than described, because the contract applies the same one and a
 * difference in tie-breaking would produce a different payoff from identical inputs — which is the
 * one failure a settlement reference service cannot have.
 */

import { describe, expect, it } from 'vitest';

import { Wad } from '@bell/calibrator/domain/models.js';

import {
  type NoPrintQualifies,
  type PrintSelected,
  ReferencePrint,
  type SelectionResult,
  bestPrint,
  selectPrint,
} from '../../src/domain/prints.js';

/** `2026-09-14T13:30:00Z`, the expiry every case here settles against. */
const EXPIRY = 1_789_392_600n;

/** Ten minutes. */
const FRESHNESS = 600n;

/** Two hours. */
const STALENESS = 7_200n;

/** A gap at WAD scale from its decimal spelling, which is how the Python's fixtures read. */
function wadOf(gap: string): bigint {
  return Wad.fromStr(gap).raw;
}

interface PrintOptions {
  readonly priority?: bigint;
  readonly secondsAfterExpiry?: bigint;
  readonly index?: bigint;
  readonly source?: string;
}

function printAt(gap: string, options: PrintOptions = {}): ReferencePrint {
  return new ReferencePrint({
    source: options.source ?? 'primary',
    priority: options.priority ?? 1n,
    timestamp: EXPIRY + (options.secondsAfterExpiry ?? 0n),
    gapWad: wadOf(gap),
    insertionIndex: options.index ?? 0n,
  });
}

function select(prints: readonly ReferencePrint[], now: bigint): SelectionResult {
  return selectPrint(prints, {
    notBefore: EXPIRY,
    now,
    freshnessBound: FRESHNESS,
    staleBound: STALENESS,
  });
}

/**
 * The result, asserted to be a selection.
 *
 * The `if` is not defensive: `SelectionResult` is a union and the assertion above does not narrow it,
 * so this is where the discriminant is turned into a type. It is the port's `isinstance` check, and
 * it throws rather than returning a sentinel because a test that reaches here with the wrong variant
 * has already failed.
 */
function expectSelected(result: SelectionResult): PrintSelected {
  expect(result.kind).toBe('selected');
  if (result.kind !== 'selected') {
    throw new Error('the selection reported no qualifying print');
  }
  return result;
}

/** The result, asserted to be a report that nothing qualified. */
function expectNone(result: SelectionResult): NoPrintQualifies {
  expect(result.kind).toBe('none');
  if (result.kind !== 'none') {
    throw new Error('the selection reported a qualifying print');
  }
  return result;
}

describe('qualification', () => {
  it('a print before the expiry does not qualify', () => {
    // A print from before the open cannot settle a session: the gap it reports is the previous
    // session's, and settling on it would pay on a return that has already been realised.
    const early = printAt('0.02', { secondsAfterExpiry: -60n });
    const result = select([early], EXPIRY);
    expect(expectNone(result).considered).toBe(1);
  });

  it('a print at the expiry qualifies', () => {
    expectSelected(select([printAt('0.02')], EXPIRY));
  });

  it('a print beyond the staleness bound does not qualify', () => {
    const result = select([printAt('0.02')], EXPIRY + STALENESS + 1n);
    expectNone(result);
  });

  it('a print exactly at the staleness bound still qualifies', () => {
    // The bound is inclusive. It is also the direction that *settles*: a print one second older
    // defers, so an off-by-one here changes the branch rather than the message.
    expectSelected(select([printAt('0.02')], EXPIRY + STALENESS));
  });

  it('a print inside the freshness bound is live', () => {
    const result = expectSelected(select([printAt('0.02')], EXPIRY + FRESHNESS));
    expect(result.isStale).toBe(false);
  });

  it('a print between the bounds is stale rather than absent', () => {
    // Stale, not absent. The distinction is the whole reason there are two bounds: a stale print
    // still settles, with the degradation recorded, whereas an absent one does not settle at all.
    const result = expectSelected(select([printAt('0.02')], EXPIRY + FRESHNESS + 1n));
    expect(result.isStale).toBe(true);
  });

  it('a print dated in the future is treated as fresh', () => {
    // A future timestamp is a feed fault, and the age floors at zero rather than going negative.
    // A negative age would pass every freshness test, which is the failure this guards.
    const future = printAt('0.02', { secondsAfterExpiry: 3_600n });
    const result = expectSelected(select([future], EXPIRY));
    expect(result.isStale).toBe(false);
  });

  it('an empty print set reports rather than raising', () => {
    expect(expectNone(select([], EXPIRY)).considered).toBe(0);
  });
});

describe('ordering', () => {
  it('the lower priority wins', () => {
    const chosen = bestPrint([
      printAt('0.01', { priority: 5n, index: 0n }),
      printAt('0.03', { priority: 1n, index: 1n }),
    ]);
    expect(chosen.gapWad).toBe(wadOf('0.03'));
  });

  it('priority outranks the timestamp', () => {
    // The case the Python's two ordering tests cannot reach between them: one holds the timestamp
    // fixed and varies the priority, the other holds the priority fixed and varies the timestamp. A
    // later print is closer to the open the session settles on, which is why the timestamp decides
    // within a priority -- but it does not promote a source above a better one.
    const chosen = bestPrint([
      printAt('0.01', { priority: 1n, secondsAfterExpiry: 0n, index: 0n }),
      printAt('0.03', { priority: 5n, secondsAfterExpiry: 60n, index: 1n }),
    ]);
    expect(chosen.gapWad).toBe(wadOf('0.01'));
  });

  it('the later timestamp wins at equal priority', () => {
    // A later print is closer to the open the session settles on.
    const chosen = bestPrint([
      printAt('0.01', { secondsAfterExpiry: 0n, index: 0n }),
      printAt('0.03', { secondsAfterExpiry: 10n, index: 1n }),
    ]);
    expect(chosen.gapWad).toBe(wadOf('0.03'));
  });

  it('the lower insertion index wins a remaining tie', () => {
    // Two prints from one source at one timestamp are the same observation, so taking the first
    // submitted is a rule rather than a preference.
    const chosen = bestPrint([printAt('0.01', { index: 7n }), printAt('0.03', { index: 2n })]);
    expect(chosen.insertionIndex).toBe(2n);
  });

  it('the ordering is total', () => {
    // No two prints compare equal, because the insertion index is unique. Asserted over every pair
    // rather than argued, because a non-total ordering is what an ambiguous settlement is.
    const candidates = Array.from({ length: 8 }, (_unused, index) =>
      printAt('0.01', { index: BigInt(index) }),
    );
    for (const left of candidates) {
      for (const right of candidates) {
        if (left.insertionIndex === right.insertionIndex) {
          continue;
        }
        const winner = bestPrint([left, right]).insertionIndex;
        expect([left.insertionIndex, right.insertionIndex]).toContain(winner);
      }
    }

    const winners = new Set([0, 1, 2].map(() => bestPrint(candidates).insertionIndex));
    expect(winners.size).toBe(1);
  });

  it('best print refuses an empty set', () => {
    expect(() => bestPrint([])).toThrow(/at least one candidate/);
  });
});

describe('the print value object', () => {
  it('magnitude is unsigned', () => {
    // **Both arms of the conditional, and the test that existed reached only one.** Every print in the
    // suite whose magnitude is read carries a negative gap, so the `>= 0` arm had never executed —
    // the branch report put it at one hit for the negation and zero for the pass-through.
    //
    // It is worth a second assertion rather than being covered by accident: a magnitude that returned
    // the *signed* value for a non-negative gap would be right, and would go on being right, until the
    // first caller that compares a magnitude against a bound read a negative one. The zero case is the
    // boundary between the two arms.
    expect(printAt('-0.02').magnitudeWad, 'negative').toBe(wadOf('0.02'));
    expect(printAt('0.02').magnitudeWad, 'positive').toBe(wadOf('0.02'));
    expect(printAt('0').magnitudeWad, 'zero').toBe(0n);
  });

  it('a negative priority is refused', () => {
    expect(() => printAt('0.02', { priority: -1n })).toThrow(/priority/);
  });

  it('a negative insertion index is refused', () => {
    expect(() => printAt('0.02', { index: -1n })).toThrow(/insertion index/);
  });
});

it('a stale bound shorter than the freshness bound is refused', () => {
  // The two bounds are ordered by construction: a stale print is one between them. Inverting them
  // would make `isStale` mean "inside the stale bound but not the freshness bound", which is the
  // empty set, and every print would report as live.
  expect(() =>
    selectPrint([], {
      notBefore: EXPIRY,
      now: EXPIRY,
      freshnessBound: STALENESS,
      staleBound: FRESHNESS,
    }),
  ).toThrow(/stale bound/);
});
