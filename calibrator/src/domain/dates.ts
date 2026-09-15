/**
 * ISO 8601 calendar dates, as the protocol's day numbers.
 *
 * **This module exists because it is the one piece of Python's standard library the port has to
 * reproduce.** The Python's `DailyBar` holds a `datetime.date`, so `rows_digest` reached for
 * `bar.trading_date.toordinal().to_bytes(4, "big")` and got both the proleptic Gregorian day number
 * and its range check from the standard library. The port's `DailyBar` holds a **string**, so the
 * same four bytes have to be computed here — and a disagreement is silent, because `rowsDigest` feeds
 * `inputsHash`, which the registry stores and nothing on chain recomputes. A wrong day number produces
 * a well-formed 32-byte digest that a challenger would simply never be able to match, which looks
 * exactly like a dishonest publisher. See `DESIGN_NOTES.md` F63.
 *
 * **It sits in `domain/` rather than beside its caller, and the reason is the CSV adapter.** Two
 * layers have to refuse a non-date: `application/calibrate.ts`, because `rowsDigest` encodes the day
 * number, and `adapters/gap_source_file.ts`, because the Python validated the date there — in the
 * adapter, with `date.fromisoformat`, which is where a malformed file's problems are supposed to live.
 * An adapter may not import the application layer, so a second copy of the rule in the adapter would
 * be the only alternative, and two copies of "what is a date" is precisely how the two come to
 * disagree. One rule, one module, two callers, each wrapping the refusal in the error type its own
 * layer owes its caller.
 *
 * **The Python validated the date nowhere else, and the port matches it.** The Python's `DailyBar` is
 * a `@dataclass(frozen=True)`, and dataclasses do not check declared types at runtime:
 * `DailyBar(trading_date="garbage", …)` constructs successfully and fails later at `.toordinal()`
 * with an `AttributeError`. Measured rather than assumed. So the port is not worse than its oracle
 * here — but it is the port's job to be *specific* about where the failure lands, which is why
 * `dateOrdinal` refuses a non-date with a named error rather than letting an `undefined` reach a byte
 * buffer.
 */

import { DomainError } from './models.js';

/**
 * The proleptic Gregorian ordinal of an ISO 8601 date, as Python's `date.toordinal()` means it.
 *
 * Day 1 is `0001-01-01`, and `1970-01-01` is day 719163. Computed arithmetically rather than through
 * `Date`, and that is deliberate rather than fussy:
 *
 * - `new Date('2020-1-6')` is invalid in every engine but `new Date('2020-01-06')` is parsed as
 *   **UTC** while `new Date('2020-01-06T00:00')` is parsed as **local** — so the same string can
 *   denote two different days depending on a suffix that is not there. A day number that depends on
 *   the host's timezone is not a cross-language contract.
 * - `Date.UTC` maps a year in 0–99 to 1900+year, so `Date.UTC(20, 0, 6)` is 1920.
 * - The algorithm below is exact integer arithmetic with no epoch, no timezone and no `Date` object.
 *
 * **The accepted format is narrowed to `YYYY-MM-DD`, and the narrowing is stated rather than
 * implied.** Measured against CPython 3.13 rather than read off the documentation, `date.fromisoformat`
 * accepts three forms this function refuses — `YYYYMMDD` (`20260910`), an ISO week date with a day
 * (`2026-W37-4`) and one without (`2026-W37`) — and refuses the ordinal form `YYYY-DDD` (`2026-006`)
 * exactly as this does. So the narrowing is three grammars, not four, and the ordinal form is not one
 * of them: an earlier version of this comment said it was, and the differential fixture `ordinal_date`
 * is what corrected it.
 *
 * Only the hyphenated form is reachable here — it is the form the CSV adapter's own header documents
 * and the only one any test or fixture uses — and the port refuses the others loudly rather than
 * reimplementing three more grammars whose disagreement would be silent. A refusal is the right
 * failure: a wrong day number is not.
 */
export function dateOrdinal(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) {
    throw new DomainError(
      `not an ISO 8601 calendar date: ${JSON.stringify(isoDate)} (expected YYYY-MM-DD)`,
    );
  }
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));

  // Python's `date.MINYEAR` is 1, and `date.fromisoformat('0000-01-01')` refuses a year of zero.
  if (year < 1) {
    throw new DomainError(`not a calendar date: ${isoDate} (year 0 is out of range)`);
  }
  if (month < 1 || month > 12) {
    throw new DomainError(`not a calendar date: ${isoDate} (month must be in 1..12)`);
  }
  const monthLength = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (monthLength === undefined || day < 1 || day > monthLength) {
    throw new DomainError(`not a calendar date: ${isoDate} (day is out of range for the month)`);
  }

  return daysFromCivil(year, month, day) + EPOCH_ORDINAL;
}

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** The proleptic Gregorian ordinal of `1970-01-01`, which is what `daysFromCivil` counts from. */
const EPOCH_ORDINAL = 719163;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Days from `1970-01-01` to `year-month-day`, by Howard Hinnant's `days_from_civil`.
 *
 * Exact for every proleptic Gregorian date, and it handles the century rules through the era
 * decomposition rather than through four separate branches. The formula is worth copying exactly
 * instead of deriving.
 *
 * **Computed in `bigint`, where Hinnant's original uses floored integer division, and the
 * substitution is stated rather than left to be noticed.** Python's `//` floors and `bigint`'s `/`
 * truncates toward zero; the two differ by one whenever the quotient is negative and inexact, which is
 * the substitution F61 was recorded for. Here they agree, and the reason is a precondition rather than
 * luck: `year >= 1` and `month` in 1..12 are enforced by `dateOrdinal` before it calls this, so
 * `adjustedYear` is at least 0, `yearOfEra` is in 0..399, and every numerator below is non-negative.
 * `Math.floor` on the same operands would also be exact — the values are small integers — but `domain/`
 * forbids `Math` outright, on the grounds that it operates on doubles and this module is the one place
 * where a double would be silent. Doing the whole computation in `bigint` satisfies that rule and makes
 * the function's own claim, *exact integer arithmetic*, literally true.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = BigInt(month <= 2 ? year - 1 : year);
  const monthBig = BigInt(month);
  const dayBig = BigInt(day);
  const era = adjustedYear / 400n;
  const yearOfEra = adjustedYear - era * 400n;
  const dayOfYear = (153n * (monthBig + (month > 2 ? -3n : 9n)) + 2n) / 5n + dayBig - 1n;
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  // The largest ordinal this module can return is 3652059, for `9999-12-31`, so the narrowing back to
  // a `number` is exact rather than approximate.
  return Number(era * 146097n + dayOfEra - 719468n);
}
