/**
 * The registry's `Branch`, mirrored.
 *
 * Solidity encodes an `enum` as its ordinal, so the ABI carries `0..4` and the meaning of each number
 * lives in the declaration order of the Solidity enum. This module is the other half of that
 * correspondence, and the order of `BRANCHES` **is** the correspondence — not a presentation choice.
 *
 * **A union rather than a TypeScript `enum`, and the reason is a compiler setting rather than taste.**
 * `tsconfig.base.json` sets `erasableSyntaxOnly`, which refuses any construct that cannot be erased to
 * plain JavaScript — and an `enum` is one, because it emits a runtime object. The union plus a frozen
 * array gives the same two things an enum would (a closed set of names, and an ordinal mapping) with
 * nothing left at runtime that the compiler had to invent.
 *
 * **`Deferred` is the member that matters to a fold.** It is the one branch on which the registry does
 * not settle: `resolve` skips `settle` entirely, so a `Resolved` carrying `Deferred` means the session
 * is still `Expired` and unsettleable until a usable print arrives. Reading it as a settlement — which
 * is what a fold that treated "a `Resolved` was emitted" as "the session resolved" would do — puts a
 * `payoffWad` of zero into the catalogue and reports a settled session that has not settled.
 */

import { DomainError } from '@bell/calibrator/domain/models.js';

/** The five resolution branches, in the order the Solidity enum declares them. */
export type Branch =
  'LivePrint' | 'StalePrint' | 'VoidAtHalf' | 'Deferred' | 'CorporateActionTerminal';

/**
 * The members in declaration order. The index is the on-chain ordinal.
 *
 * `Object.freeze` because the ordinal mapping is a fact about a deployed contract, and a mutable table
 * of it is a table that can be reordered at run time.
 */
export const BRANCHES: readonly Branch[] = Object.freeze([
  'LivePrint',
  'StalePrint',
  'VoidAtHalf',
  'Deferred',
  'CorporateActionTerminal',
]);

/**
 * The branch an ordinal names, refusing anything outside the enum.
 *
 * The refusal is the point. A sixth member added to the Solidity enum would arrive as `5`, and a
 * lookup that fell back to a default would file it as whichever branch the default happened to be —
 * the same fail-open shape `ReferenceRegistry`'s own branch switch refuses with `UnreachableBranch`.
 *
 * The range is checked on the `bigint` *before* it becomes an index, so the conversion never sees a
 * value it could round. A `uint8` from the ABI cannot exceed 255, but the check is on the value rather
 * than on the width, because the width is a property of the parameter and the check has to hold even
 * if a decoder reads the wrong one.
 */
export function branchFromCode(code: bigint): Branch {
  if (code < 0n || code >= BigInt(BRANCHES.length)) {
    throw new DomainError(
      `not a Branch ordinal: ${code.toString()} (the enum has ${String(BRANCHES.length)} members)`,
    );
  }
  const branch = BRANCHES[Number(code)];
  // `noUncheckedIndexedAccess` makes the lookup `Branch | undefined`, and the range check above proves
  // the `undefined` arm cannot be taken. Hinted rather than tested, for the reason the three depth
  // guards elsewhere in `domain/` are: the only test that could reach it would call this function with
  // an ordinal the guard has already refused, so it would assert the guard against itself.
  /* v8 ignore next 3 */
  if (branch === undefined) throw new DomainError(`no branch at ordinal ${code.toString()}`);
  return branch;
}

/**
 * Whether a resolution on this branch settled the session.
 *
 * Named rather than written inline as `branch !== 'Deferred'`, because the inline form reads as a
 * special case while this is the rule: four of the five branches settle and the fifth is the absence
 * of a decision.
 */
export function settlesSession(branch: Branch): boolean {
  return branch !== 'Deferred';
}
