/**
 * The calibration use case.
 *
 * One function, four steps, in the order the brief's §4.2 lists them: estimate the leverage on the
 * session's own window, fit the premium, publish a parameter set, and commit it before the session
 * opens. The commit is `application/publish.ts`; this module produces the parameter set it commits.
 *
 * Everything here is a *use case* rather than domain: it sequences the domain's pieces and it touches
 * nothing. The bars arrive as a sequence of value objects, the family arrives as a strategy, and the
 * hash arrives as a port — so the whole function is callable with literals, which is the brief's test
 * for whether something belongs in this layer rather than in `domain/`.
 *
 * **The one piece of Python's standard library this module has to reproduce is `date.toordinal()`**,
 * and it is the reason `dateOrdinal` is exported rather than private. The Python's `DailyBar` holds a
 * `datetime.date`, so `rows_digest` reached for `bar.trading_date.toordinal().to_bytes(4, "big")` and
 * got both the proleptic Gregorian day number and its range check from the standard library. The
 * port's `DailyBar` holds a **string**, so the same four bytes have to be computed here — and a
 * disagreement is silent, because `rowsDigest` feeds `inputsHash`, which the registry stores and
 * nothing on chain recomputes. A wrong day number produces a well-formed 32-byte digest that a
 * challenger would simply never be able to match, which looks exactly like a dishonest publisher.
 * See `DESIGN_NOTES.md` F63.
 *
 * **The Python validated the date nowhere, either.** Its `DailyBar` is a `@dataclass(frozen=True)`,
 * and dataclasses do not check declared types at runtime: `DailyBar(trading_date="garbage", …)`
 * constructs successfully and fails later at `.toordinal()` with an `AttributeError`. Measured rather
 * than assumed. So the port is not worse than its oracle here — but it is the port's job to be
 * *specific* about where the failure lands, which is why `dateOrdinal` refuses a non-date with a named
 * error rather than letting an `undefined` reach a byte buffer.
 */

import { type Decimal } from 'decimal.js';

import {
  ALPHA_WAD,
  OVERNIGHT_WINDOW_SESSIONS,
  OVERNIGHT_WINDOW_SESSIONS_AAPL,
  ROUNDING_LATTICE_WAD,
  WAD,
  WEEKEND_WINDOW_SESSIONS,
} from '../domain/constants.js';
import { inputsHash, uintToBytes } from '../domain/digest.js';
import { type DistributionFamily, GapSample, SEED_FAMILY } from '../domain/families/index.js';
import { latticeLeverage } from '../domain/leverage.js';
import {
  type CalibrationResult,
  type DailyBar,
  ParameterSet,
  SessionKind,
  type Symbol,
  Wad,
} from '../domain/models.js';
import { D } from '../domain/moments.js';
import { type Keccak } from '../domain/ports.js';

/** Thrown by the calibration use case when it refuses its input. */
export class CalibrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibrationError';
  }
}

const UINT32_BYTES = 4;
const UINT256_BYTES = 32;

/**
 * The saturation probability, from the exact integer constant.
 *
 * The screen below compares `n * alpha` against a threshold, and doing it in integers means the
 * boundary is exact — a float would put a sample of exactly the required size on the wrong side
 * roughly half the time.
 */
const ALPHA = ALPHA_WAD;

/**
 * One tail observation is the minimum that can place a quantile at all.
 *
 * The paper's §7.8 frames the governing quantity as `n * alpha` — 19.65 overnight, 4.52 on a weekend,
 * 0.96 on a holiday — and a holiday window below one is exactly why holidays are pooled rather than
 * calibrated per name.
 */
export const DEFAULT_MINIMUM_TAIL_OBSERVATIONS_WAD: bigint = WAD;

/** What to calibrate, over which window, with which family. */
export class CalibrationRequest {
  readonly symbol: Symbol;
  readonly session: SessionKind;
  readonly windowSessions: number;
  readonly sourceIds: readonly string[];
  readonly familyName: string;
  readonly minimumTailObservationsWad: bigint;

  /**
   * A parameter object rather than six arguments, per the brief's §8.1 rule that a function taking
   * more than five parameters should take one.
   */
  constructor(fields: {
    symbol: Symbol;
    session: SessionKind;
    windowSessions: number;
    sourceIds: readonly string[];
    familyName?: string;
    minimumTailObservationsWad?: bigint;
  }) {
    if (fields.windowSessions <= 0) {
      throw new CalibrationError('a calibration window needs at least one session');
    }
    if (fields.sourceIds.length === 0) {
      throw new CalibrationError('a parameter set has to name the sources its inputs came from');
    }
    this.symbol = fields.symbol;
    this.session = fields.session;
    this.windowSessions = fields.windowSessions;
    this.sourceIds = fields.sourceIds;
    this.familyName = fields.familyName ?? SEED_FAMILY;
    this.minimumTailObservationsWad =
      fields.minimumTailObservationsWad ?? DEFAULT_MINIMUM_TAIL_OBSERVATIONS_WAD;
  }
}

/**
 * Estimate the leverage and fit the premium for one `(name, session)`.
 *
 * The window is taken from the *end* of the series, since a parameter set is committed before the
 * session it describes opens and the only observations available are the ones behind it. Taking the
 * head would calibrate on the oldest data in the series.
 *
 * A calibration either produced a parameter set or could not, and the second is a domain result
 * rather than an exception: "the sample cannot support an estimate" is ordinary.
 */
export function calibrate(
  request: CalibrationRequest,
  bars: readonly DailyBar[],
  family: DistributionFamily,
  keccak: Keccak,
): CalibrationResult {
  if (bars.length < request.windowSessions) {
    return {
      kind: 'insufficient',
      symbol: request.symbol,
      session: request.session,
      observations: bars.length,
      requiredTailObservations: request.windowSessions,
    };
  }

  const window = bars.slice(bars.length - request.windowSessions);
  const sample = new GapSample(window.map((bar) => bar.gap().raw));

  if (BigInt(sample.count) * ALPHA < request.minimumTailObservationsWad) {
    // The screen that makes holidays pooled rather than per-name. It is a screen on the *tail count*
    // and not on the sample size, because what governs an order statistic is how many observations
    // sit at or beyond the quantile being estimated.
    return {
      kind: 'insufficient',
      symbol: request.symbol,
      session: request.session,
      observations: sample.count,
      requiredTailObservations: Number(request.minimumTailObservationsWad / ALPHA),
    };
  }

  const lamWad = estimateLeverage(sample);
  const fit = family.fit(lamWad, sample);

  return {
    kind: 'calibrated',
    parameters: new ParameterSet({
      symbol: request.symbol,
      session: request.session,
      lam: new Wad(lamWad),
      premium: new Wad(fit.premiumWad),
      inputsHash: inputsHash(
        keccak,
        request.windowSessions,
        request.session,
        request.sourceIds,
        sample.count,
        rowsDigest(keccak, window),
      ),
      model: family.name,
    }),
  };
}

/**
 * `floor(1 / cap)`, with the cap rounded up to the published lattice first.
 *
 * The lattice step is not optional and it is not cosmetic: the same measured quantile publishes three
 * different leverages on a 1%, a 0.5% and a 0.25% grid, so an unstated grid is an unstated
 * instrument. The grid is stated in `spec/constants.yaml` and the round-up direction is the one the
 * paper's published values reproduce.
 */
function estimateLeverage(sample: GapSample): bigint {
  const quantile = sample.quantileMagnitudeWad(oneMinusAlpha());
  return latticeLeverage(new Wad(quantile), new Wad(ROUNDING_LATTICE_WAD)).raw;
}

/**
 * `1 - alpha`, from the exact integer constant.
 *
 * Built from the WAD constant rather than written as `0.99`, so that changing `alpha` in
 * `spec/constants.yaml` changes the quantile the leverage rule reads. The subtraction happens in
 * integers and only the division is decimal, so the value is exact rather than approximately 0.99 —
 * and exact at *any* precision, which is why this site is not one of F60's masked nine.
 */
export function oneMinusAlpha(): Decimal {
  return new D(WAD - ALPHA).div(new D(WAD));
}

/**
 * The digest of the rows a fit consumed.
 *
 * Canonical, and deliberately the *minimal* sufficient serialisation: the date, the close and the
 * next open, each at WAD scale, in the order the window holds them. A challenger has to be able to
 * reproduce this from the same inputs, so anything not part of the gap — a volume, a high, a low — is
 * excluded rather than carried along.
 *
 * The range checks that Python's `int.to_bytes` performed are `uintToBytes`'s, which is why the
 * port reuses `digest.ts`'s rather than writing a second one: a silent truncation here produces a
 * preimage that hashes to something plausible and matches nothing.
 */
export function rowsDigest(keccak: Keccak, window: readonly DailyBar[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const bar of window) {
    parts.push(uintToBytes(BigInt(dateOrdinal(bar.tradingDate)), UINT32_BYTES, 'tradingDate'));
    parts.push(uintToBytes(bar.close.raw, UINT256_BYTES, 'close'));
    parts.push(uintToBytes(bar.nextOpen.raw, UINT256_BYTES, 'nextOpen'));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }
  return keccak(payload);
}

/**
 * The calibration window for a session, in sessions.
 *
 * Chosen by forward error in the paper's §7.9 rather than by intuition, and the two facts worth
 * carrying are that longer is better on the overnight session and that the weekend sample cannot
 * support a per-name window at all. AAPL's overnight window is 378 not 504, which is the one per-name
 * exception the paper records.
 *
 * An event session has no pooled window at all, and the refusal is an error rather than a result:
 * asking for one is a caller mistake, not an outcome of the data. The message interpolates the
 * session's *code* — `C`, not `SessionKind.EVENT` — which is what Python's `StrEnum` formatting does
 * and therefore what the oracle prints.
 */
export function windowFor(session: SessionKind, symbol: Symbol): number {
  if (session === SessionKind.OVERNIGHT) {
    if (symbol.text === 'AAPL') return Number(OVERNIGHT_WINDOW_SESSIONS_AAPL);
    return Number(OVERNIGHT_WINDOW_SESSIONS);
  }
  if (session === SessionKind.WEEKEND || session === SessionKind.HOLIDAY) {
    return Number(WEEKEND_WINDOW_SESSIONS);
  }
  throw new CalibrationError(
    `the ${session} session has no pooled window; event sessions are calibrated per name`,
  );
}

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
 * implied.** Python's `date.fromisoformat` also accepts `YYYYMMDD`, an ISO week date (`2020-W02-1`)
 * and an ordinal date (`2020-006`). Only the first form is reachable here — it is the form the CSV
 * adapter's own header documents and the only one any test or fixture uses — and the port refuses the
 * others loudly rather than reimplementing three more grammars whose disagreement would be silent.
 * A refusal is the right failure: a wrong day number is not.
 */
export function dateOrdinal(isoDate: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) {
    throw new CalibrationError(
      `not an ISO 8601 calendar date: ${JSON.stringify(isoDate)} (expected YYYY-MM-DD)`,
    );
  }
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));

  // Python's `date.MINYEAR` is 1, and `date.fromisoformat('0000-01-01')` refuses a year of zero.
  if (year < 1) {
    throw new CalibrationError(`not a calendar date: ${isoDate} (year 0 is out of range)`);
  }
  if (month < 1 || month > 12) {
    throw new CalibrationError(`not a calendar date: ${isoDate} (month must be in 1..12)`);
  }
  const monthLength = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (monthLength === undefined || day < 1 || day > monthLength) {
    throw new CalibrationError(
      `not a calendar date: ${isoDate} (day is out of range for the month)`,
    );
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
 * decomposition rather than through four separate branches. `Math.floor` is the correct rounding
 * rather than `Math.trunc`: the era and year-of-era terms are computed as floored quotients so that
 * the formula stays a bijection across a negative year, which is why the formula is worth copying
 * exactly instead of deriving.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}
