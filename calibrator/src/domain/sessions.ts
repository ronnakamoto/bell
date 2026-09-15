/**
 * Session classification by calendar span.
 *
 * Pure: a span and an announcement flag in, a session kind out. No calendar, no clock.
 *
 * **The ordering in `classify` is the whole rule.** An announcement session is tested first and
 * short-circuits the span, because an announcement gap is `Overnight` by duration and a different
 * object by distribution — a rule that tested the span first would pool it with the overnight sample
 * and understate the premium by 4.0 to 16.5% (paper §7.10).
 *
 * **The span constants are declared here rather than in `spec/constants.yaml`, deliberately.** The
 * single-source rule exists because the same number in two languages is a bug waiting to diverge, and
 * these three have no Solidity consumer: the chain receives a `SessionKind` byte and never a calendar
 * span, so there is no second language for them to disagree with. `constants.ts` holds the *windows*
 * (`OVERNIGHT_WINDOW_SESSIONS` and friends) precisely because those are emitted into `Constants.sol`.
 * The tracker's entry for this item claims a dependency on `constants.ts`; the module has none, in
 * either language.
 *
 * The port raises `DomainError` rather than a module-specific subclass. `SessionSpan` is a value
 * object of exactly the kind `models.ts` already covers — constructed once, validated at
 * construction, never mutated — and a caller that catches `DomainError` to separate "the domain
 * rejected this datum" from "something threw" would otherwise miss this one.
 */

import { DomainError, SessionKind } from './models.js';

/** A one-day span: a close and the next open. */
export const OVERNIGHT_SPAN_DAYS = 1;

/** A three-day span: a Friday close to a Monday open. */
export const WEEKEND_SPAN_DAYS = 3;

/**
 * The spans the design calls holidays.
 *
 * **Read by nothing, in either language, and that is the reason it is documented rather than
 * deleted.** `classify` reaches `HOLIDAY` by falling through, so it answers `HOLIDAY` for 2, 4 and 5
 * *and* for 6, 7 and anything else — this set is a strict subset of what the function returns. The
 * trap is that it reads like a validation rule: a reviewer or a future refactorer who tightens
 * `classify` to `HOLIDAY_SPANS_DAYS.has(span.calendarDays)` would introduce a hole for every span
 * above five, and the existing tests would still pass. Recorded as DESIGN_NOTES.md F59.
 */
export const HOLIDAY_SPANS_DAYS: ReadonlySet<number> = new Set([2, 4, 5]);

/**
 * The calendar span of a gap, in days, plus whether an announcement falls inside it.
 *
 * `calendarDays` is a `number` and not a `bigint`, matching `InsufficientSample.observations`: it is
 * a count of days, not a quantity at a scale. The guard tests the lower bound only, as the Python's
 * does, so a fractional span is constructible here and there alike — it is not reachable, because the
 * adapter derives the span from a difference of two dates.
 */
export class SessionSpan {
  readonly calendarDays: number;
  readonly containsScheduledAnnouncement: boolean;

  constructor(fields: { calendarDays: number; containsScheduledAnnouncement?: boolean }) {
    if (fields.calendarDays < OVERNIGHT_SPAN_DAYS) {
      throw new DomainError('a gap spans at least one calendar day');
    }
    this.calendarDays = fields.calendarDays;
    this.containsScheduledAnnouncement = fields.containsScheduledAnnouncement ?? false;
  }
}

/**
 * Classify a gap into the session taxonomy.
 *
 * The spans are the design's own: 1 day is overnight, 3 days is a weekend, everything else is a
 * holiday. A 2-day span is a holiday rather than a short weekend, which is a calendar fact rather
 * than a choice — it is a Friday close to a Tuesday open, so a holiday intervened.
 *
 * Not called anywhere in production yet, in either language. The session arrives at the application
 * layer as data (`calibrate.py` takes a `session: SessionKind` and `window_for` switches on it), so
 * this is the rule that ingestion is expected to apply upstream of the calibrator. Nothing asserts
 * that ingestion does.
 */
export function classify(span: SessionSpan): SessionKind {
  if (span.containsScheduledAnnouncement) return SessionKind.EVENT;
  if (span.calendarDays === OVERNIGHT_SPAN_DAYS) return SessionKind.OVERNIGHT;
  if (span.calendarDays === WEEKEND_SPAN_DAYS) return SessionKind.WEEKEND;
  return SessionKind.HOLIDAY;
}

/**
 * Whether the session's parameters are pooled rather than per-name.
 *
 * Overnight is the only session whose per-name estimate is publishable: it has 19.65 expected tail
 * observations against 4.52 on a weekend, 0.96 on a holiday and 0.34 in an event session, and a
 * weekend's per-name spread of leverage is no larger than its own standard error — which makes a
 * per-name weekend number an estimate of nothing rather than a noisy estimate of something
 * (paper §7.8, Table 14).
 *
 * The name reads as "pooled with the weekend" because the weekend is the session it is pooled with;
 * the predicate is really "pooled at all", which is why it is written as a negation of the one
 * exception rather than as a membership test.
 */
export function isPooledWithWeekend(kind: SessionKind): boolean {
  return kind !== SessionKind.OVERNIGHT;
}

/**
 * `n * alpha`, the quantity that governs whether a per-name quantile can be published.
 *
 * Not the sample size: what governs an order statistic is how many observations sit at or beyond the
 * quantile being estimated. At `alpha = 1%` that is one observation in a hundred, which is why a
 * 126-session weekend window holds roughly one tail draw and cannot locate the quantile at all.
 *
 * **Note the paper writes this quantity as `n(1 - alpha)` in §7.8 and Table 14, but its own numbers
 * are `n * alpha`:** 1,965 overnight observations give 19.65, not 1,945.35, and 452 weekend
 * observations give 4.52, not 447.48. `alpha` is the saturation probability, i.e. the probability of
 * landing in the top per cent, so the expected tail count is `n * alpha` and the paper's notation is
 * the slip. The values are used, not the notation — DESIGN_NOTES.md F12.
 *
 * `number` is used here and only here: this is a screening count used to choose between estimators,
 * never a money or probability quantity that reaches a parameter set. It is also the one place in
 * this module where the arithmetic is IEEE-754 rather than exact, and the port reproduces the Python
 * bit for bit — `1965 * 0.01` is `19.650000000000002` in both languages, which is why the test
 * compares to a tolerance rather than for equality.
 */
export function expectedTailObservations(observations: number, alpha: number): number {
  return observations * alpha;
}
