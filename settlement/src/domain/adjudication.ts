/**
 * Challenge adjudication: re-run a committed fit from its committed inputs.
 *
 * This is the mechanism that makes a challenge a *verification* rather than a matter of testimony.
 * The arbiter does not decide whether a published parameter is good; it decides whether the parameter
 * matches what the committed inputs produce. That is a deterministic re-run, and it is only possible
 * because `inputsHash` is committed alongside the parameter — without it the whole mechanism degrades
 * to trusting the publisher, which is the exact failure the commitment exists to prevent.
 *
 * Result types throughout, because every outcome here is expected rather than exceptional: a
 * parameter that matches, a parameter that does not, and inputs that cannot be retrieved are three
 * ordinary results of running the check, not three errors.
 *
 * The fit itself is injected. `adjudicate` takes a callable rather than importing the calibrator's
 * fitters, so that the settlement service decides *what to compare* and the calibrator decides *how
 * to fit* — and so that the comparison can be tested against a stub without a sample.
 *
 * **`adjudicate` is `async`, where the Python's is a plain call.** The Python's `RefitRunner` is a
 * synchronous `Callable[[bytes], RefittedParameters | None]`, and the only implementation that will
 * ever exist reads the committed rows from a `CommittedInputStore` — which is a `Promise`-returning
 * port, because the real store is a database or a chain. So the injected collaborator is
 * asynchronous and the function that calls it has to be. This is the same departure
 * `ParameterPublisher.publish` carries, and it is not the domain doing I/O: the domain awaits a
 * collaborator it was handed, and `digestMatches` — which needs only the pure `keccak` — stays
 * synchronous.
 *
 * **Every byte comparison goes through `bytesEqual`.** Python's `bytes == bytes` compares content and
 * JavaScript's `===` on two `Uint8Array`s compares references, so the obvious translation of
 * `computed == expected_digest` is silently wrong in the direction that matters most here: a digest
 * that *does* reproduce would be reported as a `DigestMismatch`. The helper is in the calibrator's
 * `models.ts`, beside `hexOf`, with the reasoning.
 *
 * **`premiumToleranceFromPrecision` computes in exact `bigint` rather than in `Decimal`.** The
 * Python is `int(Decimal(5) / Decimal(10) ** (decimal_places + 1) * WAD)`, and every step of that is
 * exact: `5 / 10^(n+1)` carries one significant digit, and multiplying by `WAD` keeps it at one, so
 * CPython's 28-digit context never rounds and `int()` never truncates anything away. The port
 * therefore computes `5 * WAD / 10^(n+1)` directly, which is the same integer for every
 * `decimalPlaces >= 0` and needs no decimal arithmetic at all. Verified across a range of precisions
 * by the A6 differential rather than argued from the digit count.
 */

import { WAD } from '@bell/calibrator/domain/constants.js';
import { commitmentDigest } from '@bell/calibrator/domain/digest.js';
import { DIGEST_BYTES, DomainError, bytesEqual } from '@bell/calibrator/domain/models.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';

// ---------------------------------------------------------------- tolerances
//
// Both are derived rather than chosen, and the derivation is the reason the two differ by six orders
// of magnitude.

/**
 * The leverage is an integer on the harmonic ladder, so it is published exactly and must match
 * exactly. A tolerance here would be a tolerance on which instrument was listed.
 */
export const LEVERAGE_TOLERANCE_WAD = 0n;

/**
 * The premium is published to four decimal places — `0.1740`, `0.1465` — so the published figure
 * carries a rounding uncertainty of 5e-5 absolute. A re-run that lands inside that is consistent with
 * the published number; one that lands outside it is not.
 */
export const PREMIUM_TOLERANCE_WAD = 5n * 10n ** 13n;

/** The fields of a commitment, named at the call site because two of the five are byte arrays. */
export interface CommittedParameterSetFields {
  readonly nameId: Uint8Array;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly inputsHash: Uint8Array;
}

/** What a publisher committed to, as the chain holds it. */
export class CommittedParameterSet {
  readonly nameId: Uint8Array;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly inputsHash: Uint8Array;

  constructor(fields: CommittedParameterSetFields) {
    if (fields.nameId.length !== DIGEST_BYTES) {
      throw new DomainError('a nameId must be 32 bytes');
    }
    if (fields.inputsHash.length !== DIGEST_BYTES) {
      throw new DomainError('an inputsHash must be 32 bytes');
    }
    if (fields.forSession < 0n) {
      throw new DomainError('a forSession cannot be negative');
    }
    this.nameId = fields.nameId;
    this.forSession = fields.forSession;
    this.lambdaWad = fields.lambdaWad;
    this.premiumWad = fields.premiumWad;
    this.inputsHash = fields.inputsHash;
  }
}

/** What re-running the fit from the committed inputs produced. */
export interface RefittedParameters {
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
}

// ---------------------------------------------------------------- the result type

/** The committed parameter matches the committed inputs. The publisher keeps its bond. */
export interface PublisherUpheld {
  readonly kind: 'upheld';
  readonly commitment: CommittedParameterSet;
  readonly refitted: RefittedParameters;
  readonly premiumDeltaWad: bigint;
  readonly digest: Uint8Array;
}

/** The committed parameter does not match the committed inputs. */
export interface PublisherSlashed {
  readonly kind: 'slashed';
  readonly commitment: CommittedParameterSet;
  readonly refitted: RefittedParameters;
  readonly reason: string;
  readonly digest: Uint8Array;
}

/**
 * The committed inputs could not be retrieved, so no ruling is possible.
 *
 * A distinct outcome from a slash, and the distinction matters: a publisher whose inputs are missing
 * has not been shown to have published a wrong parameter, and slashing it would make the bond
 * forfeitable by anyone who can suppress a data source.
 */
export interface InputsUnavailable {
  readonly kind: 'inputs-unavailable';
  readonly commitment: CommittedParameterSet;
  readonly reason: string;
}

/**
 * The commitment is internally inconsistent: its digest is not the digest of its fields.
 *
 * Also distinct from a slash, and the difference is who is at fault. A digest mismatch means the chain
 * holds a commitment whose fields do not hash to what was recorded, which is a fault in the
 * commitment rather than a bad fit.
 */
export interface DigestMismatch {
  readonly kind: 'digest-mismatch';
  readonly commitment: CommittedParameterSet;
  readonly expected: Uint8Array;
  readonly computed: Uint8Array;
}

export type AdjudicationResult =
  PublisherUpheld | PublisherSlashed | InputsUnavailable | DigestMismatch;

/**
 * A re-run of a committed fit. Resolves `undefined` when the inputs cannot be retrieved, which is a
 * domain outcome rather than an exception — an unavailable data source is ordinary, not exceptional,
 * and making it an exception would force every caller to catch one.
 */
export type RefitRunner = (inputsHash: Uint8Array) => Promise<RefittedParameters | undefined>;

/** The three knobs `adjudicate` takes, all of them defaulted. */
export interface AdjudicationOptions {
  readonly expectedDigest?: Uint8Array | undefined;
  readonly leverageToleranceWad?: bigint | undefined;
  readonly premiumToleranceWad?: bigint | undefined;
}

/**
 * Rule on whether a committed parameter matches its committed inputs.
 *
 * The order of the checks is the order of their precedence. The digest is verified first, since a
 * commitment whose fields do not hash to its recorded digest is not the commitment the publisher made
 * and nothing downstream of it means anything. Then the re-run, because an unavailable input is not a
 * ruling. Only then the comparison.
 */
export async function adjudicate(
  commitment: CommittedParameterSet,
  refit: RefitRunner,
  keccak: Keccak,
  options: AdjudicationOptions = {},
): Promise<AdjudicationResult> {
  const computed = digestOf(commitment, keccak);
  const expected = options.expectedDigest;
  if (expected !== undefined && !bytesEqual(computed, expected)) {
    return { kind: 'digest-mismatch', commitment, expected, computed };
  }

  const refitted = await refit(commitment.inputsHash);
  if (refitted === undefined) {
    return {
      kind: 'inputs-unavailable',
      commitment,
      reason: 'the committed inputs could not be retrieved, so no ruling is possible',
    };
  }

  const leverageTolerance = options.leverageToleranceWad ?? LEVERAGE_TOLERANCE_WAD;
  const leverageDelta = absoluteDifference(refitted.lambdaWad, commitment.lambdaWad);
  if (leverageDelta > leverageTolerance) {
    return {
      kind: 'slashed',
      commitment,
      refitted,
      reason:
        `the committed leverage is off the lattice the committed inputs produce by ` +
        `${leverageDelta.toString()} wei; the leverage is an integer and is published exactly`,
      digest: computed,
    };
  }

  const premiumTolerance = options.premiumToleranceWad ?? PREMIUM_TOLERANCE_WAD;
  const premiumDelta = absoluteDifference(refitted.premiumWad, commitment.premiumWad);
  if (premiumDelta > premiumTolerance) {
    return {
      kind: 'slashed',
      commitment,
      refitted,
      reason:
        `the committed premium differs from the re-run by ${premiumDelta.toString()} wei, beyond ` +
        `the ${premiumTolerance.toString()} wei the published precision allows`,
      digest: computed,
    };
  }

  return {
    kind: 'upheld',
    commitment,
    refitted,
    premiumDeltaWad: premiumDelta,
    digest: computed,
  };
}

/**
 * Whether the commitment's fields hash to the digest the chain recorded.
 *
 * Exposed separately because a challenger needs it *before* committing a bond: a commitment whose
 * digest does not reproduce is a challenge that cannot lose, and a challenger who has to spend the
 * bond to find that out is being charged for the publisher's bookkeeping.
 */
export function digestMatches(
  commitment: CommittedParameterSet,
  expectedDigest: Uint8Array,
  keccak: Keccak,
): boolean {
  return bytesEqual(digestOf(commitment, keccak), expectedDigest);
}

/**
 * The premium tolerance implied by a published precision, at WAD scale.
 *
 * Half a unit in the last published place. Four decimal places gives 5e-5, which is the value
 * `PREMIUM_TOLERANCE_WAD` carries; the function exists so that a change to the published precision is
 * a change in one place rather than a constant someone has to remember to update.
 *
 * See the header for why this is integer arithmetic rather than a `Decimal` quotient, and why that is
 * not a departure in value.
 */
export function premiumToleranceFromPrecision(decimalPlaces: number): bigint {
  if (decimalPlaces < 0) {
    throw new DomainError('a precision cannot be negative');
  }
  return (5n * WAD) / 10n ** BigInt(decimalPlaces + 1);
}

/** `commitmentDigest` over a commitment's own fields, which both entry points need. */
function digestOf(commitment: CommittedParameterSet, keccak: Keccak): Uint8Array {
  return commitmentDigest(
    keccak,
    commitment.nameId,
    commitment.forSession,
    commitment.lambdaWad,
    commitment.premiumWad,
    commitment.inputsHash,
  );
}

/** `|left - right|`, spelled out because `Math.abs` does not accept a `bigint`. */
function absoluteDifference(left: bigint, right: bigint): bigint {
  const delta = left - right;
  return delta < 0n ? -delta : delta;
}
