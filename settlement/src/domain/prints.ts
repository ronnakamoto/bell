/**
 * Reference prints, and the deterministic selection over them.
 *
 * This module mirrors `contracts/src/core/ReferencePrintBook.sol` deliberately and in detail: the
 * same qualification rule, the same ordering, the same refusal. The two have to agree. A settlement
 * evaluated here and a settlement evaluated on chain must reach the same branch from the same
 * prints, because a difference in tie-breaking would produce a *different payoff* from identical
 * inputs — which is the one failure a settlement reference service cannot have, since the whole
 * point of the reference is to be checkable against the contract.
 *
 * The ordering is `(priority ascending, timestamp descending, insertion index ascending)`, and it is
 * total: no two prints compare equal, because the insertion index is unique.
 *
 * Result types rather than exceptions for the absent case, because "no print qualifies" is a domain
 * outcome rather than a failure. The contract reverts, because a contract has no other way to say it.
 *
 * **A time is a `bigint` count of Unix seconds, and that is the port's first decision rather than a
 * detail.** The Python holds a `datetime` and a `timedelta`; the contract holds a `uint64 timestamp`
 * and a `uint64 freshnessBoundSeconds`. Those are two representations of one quantity, and the port
 * has to pick one. It picks the contract's, for three reasons:
 *
 * 1. *The contract's is the one that has to agree.* This module exists so that an off-chain and an
 *    on-chain evaluation of the same prints reach the same branch. A representation that must be
 *    converted to reach the chain puts the conversion at exactly the point where an off-by-one is
 *    silent — the argument that made `dateOrdinal` an exported function with its own test rather
 *    than a call into a date library (DESIGN_NOTES.md F63).
 * 2. *`Date` is not available to `domain/`.* `getTime()` returns a `number` — an IEEE-754 double
 *    counting milliseconds — so a `Date` is a double in a costume, which is what the domain's `Math`
 *    ban exists to keep out. It can also read the clock, i.e. reach the world, which the §5.3
 *    dependency rule forbids the domain from doing.
 * 3. *Every operation here is a comparison or a subtraction.* Both are exact on `bigint`, and
 *    neither needs a calendar. A `datetime` would buy a timezone, a DST table and a microsecond
 *    field, and this module consults none of the three.
 *
 * **The departure that creates, stated rather than left to be discovered.** The Python's resolution
 * is one microsecond; the port's is one second; the contract's is one second. So the port is
 * *narrower* than the oracle and *equal* to the contract, and the narrowing discards only inputs the
 * chain cannot represent: a print stamped `13:30:00.5` has an age of 0 seconds here and 0.5 there.
 * A caller holding a `datetime` converts at the boundary, in one line, where the loss is visible.
 * Verified rather than asserted — the A6 differential carries sub-second fixtures and enumerates
 * them as named differences, so the set of inputs on which the two disagree is a measured list.
 *
 * **`bigint` for every field, not `number`.** `priority` and `insertionIndex` are `uint64` on chain,
 * and a `number` above 2^53 is silently rounded — the rule the JSON fixtures already carry
 * (DESIGN_NOTES.md F52).
 */

import { DomainError } from '@bell/calibrator/domain/models.js';

// ---------------------------------------------------------------- the print

/** The fields of a print, named at the call site because three of the five are `bigint`. */
export interface PrintFields {
  /** Which feed reported it. Carried so a settlement record names its evidence. */
  readonly source: string;
  /** Lower wins. The feed's own rank, not a weight. */
  readonly priority: bigint;
  /** When the observation was made, as Unix seconds. */
  readonly timestamp: bigint;
  /** The reported gap, signed and at WAD scale. */
  readonly gapWad: bigint;
  /** The order this print entered the book, unique per book, which is what makes the order total. */
  readonly insertionIndex: bigint;
}

/**
 * One reported observation of a session's gap.
 *
 * `gapWad` is signed and at WAD scale. The payoff is an even function of it, so a negative gap
 * settles exactly as its magnitude does, but the sign is carried because a settlement record that
 * discarded it could not be audited against the print it came from.
 */
export class ReferencePrint {
  readonly source: string;
  readonly priority: bigint;
  readonly timestamp: bigint;
  readonly gapWad: bigint;
  readonly insertionIndex: bigint;

  constructor(fields: PrintFields) {
    if (fields.priority < 0n) {
      throw new DomainError('a print priority cannot be negative');
    }
    if (fields.insertionIndex < 0n) {
      throw new DomainError('an insertion index cannot be negative');
    }
    this.source = fields.source;
    this.priority = fields.priority;
    this.timestamp = fields.timestamp;
    this.gapWad = fields.gapWad;
    this.insertionIndex = fields.insertionIndex;
  }

  /**
   * `|gap|`, which is what every magnitude guard compares against.
   *
   * Spelled as a conditional rather than as `Math.abs`, which does not accept a `bigint` and is
   * banned in `domain/` anyway for the reason the ban exists: it operates on doubles.
   */
  get magnitudeWad(): bigint {
    return this.gapWad < 0n ? -this.gapWad : this.gapWad;
  }
}

// ---------------------------------------------------------------- the result type

/** A print qualified, and this is the one. */
export interface PrintSelected {
  readonly kind: 'selected';
  readonly print: ReferencePrint;
  readonly isStale: boolean;
}

/** Nothing qualified. A designed outcome, not a failure. */
export interface NoPrintQualifies {
  readonly kind: 'none';
  readonly considered: number;
  readonly reason: string;
}

export type SelectionResult = PrintSelected | NoPrintQualifies;

// ---------------------------------------------------------------- selection

/**
 * The window a print is selected in, and the two ages that classify it.
 *
 * Passed as one object rather than as four `bigint` parameters. The Python made the same four
 * keyword-only (`select_print(prints, *, not_before, now, freshness_bound, stale_bound)`), and the
 * reason survives the translation unchanged: four positional arguments of the same type are a
 * signature in which a swap is silent, and this module's whole subject is a tie-break that must not
 * be got subtly wrong.
 */
export interface SelectionBounds {
  /** The session's expiry. A print from before it cannot settle the session. */
  readonly notBefore: bigint;
  /** When settlement is being evaluated. */
  readonly now: bigint;
  /** At or inside this age a print is live. */
  readonly freshnessBound: bigint;
  /** At or inside this age a print still settles, as stale. Beyond it, nothing settles. */
  readonly staleBound: bigint;
}

/**
 * The settlement print, or a report that none qualifies.
 *
 * A print qualifies when it was observed at or after `notBefore` — the session's expiry itself — so
 * a print from before the open cannot settle it, and when it is no older than `staleBound`. Within
 * the freshness bound it is live; between the two it is stale, and the caller is told which rather
 * than having to infer it.
 */
export function selectPrint(
  prints: readonly ReferencePrint[],
  bounds: SelectionBounds,
): SelectionResult {
  if (bounds.staleBound < bounds.freshnessBound) {
    throw new DomainError('the stale bound cannot be shorter than the freshness bound');
  }

  const candidates = prints.filter((candidate) => qualifies(candidate, bounds));
  if (candidates.length === 0) {
    return {
      kind: 'none',
      considered: prints.length,
      reason: 'no print was observed after the expiry and inside the staleness bound',
    };
  }

  const chosen = bestPrint(candidates);
  return {
    kind: 'selected',
    print: chosen,
    isStale: age(chosen.timestamp, bounds.now) > bounds.freshnessBound,
  };
}

/**
 * The winning print under the total ordering.
 *
 * Written as three explicit comparisons rather than as a sort key. The Python's stated reason for
 * that shape was that a key would have to carry the timestamp *negated*, and negating a `datetime`
 * is a `float` in domain code. There is no negation here — `bigint` has no float to fall into — so a
 * key would be safe; the comparisons are kept because they read in the same order as the sentence
 * above them, and an ordering nobody has to decode is an ordering nobody has to re-derive.
 *
 * The equivalence to the Python's three passes is not argued from the shape of the code: the ported
 * pair test asserts the winner for every pair of an eight-print set, and the differential asserts it
 * against the oracle for every fixture.
 */
export function bestPrint(candidates: readonly ReferencePrint[]): ReferencePrint {
  const seed = candidates[0];
  if (seed === undefined) {
    throw new DomainError('bestPrint needs at least one candidate');
  }

  let winner = seed;
  for (const candidate of candidates) {
    if (outranks(candidate, winner)) {
      winner = candidate;
    }
  }
  return winner;
}

/**
 * Whether `candidate` outranks `incumbent` under `(priority asc, timestamp desc, index asc)`.
 *
 * The three comparisons are exhaustive and mutually exclusive, so the ordering is a strict total
 * order on prints that differ in `insertionIndex` — which is what "no two prints compare equal"
 * means, and why `bestPrint` needs no tie-break of last resort.
 */
function outranks(candidate: ReferencePrint, incumbent: ReferencePrint): boolean {
  if (candidate.priority !== incumbent.priority) {
    return candidate.priority < incumbent.priority;
  }
  if (candidate.timestamp !== incumbent.timestamp) {
    return candidate.timestamp > incumbent.timestamp;
  }
  return candidate.insertionIndex < incumbent.insertionIndex;
}

/** Whether a print may settle: observed at or after the expiry, and no older than the stale bound. */
function qualifies(candidate: ReferencePrint, bounds: SelectionBounds): boolean {
  if (candidate.timestamp < bounds.notBefore) {
    return false;
  }
  return age(candidate.timestamp, bounds.now) <= bounds.staleBound;
}

/**
 * The print's age, floored at zero.
 *
 * Floored rather than signed because a print dated in the future is a feed fault, not a negative
 * age, and a negative age would pass every freshness test. The contract does the same, for the same
 * reason — `ReferencePrintBook._ageOf` carries the identical floor.
 */
function age(timestamp: bigint, now: bigint): bigint {
  return now >= timestamp ? now - timestamp : 0n;
}
