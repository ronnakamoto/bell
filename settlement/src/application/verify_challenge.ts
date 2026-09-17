/**
 * Challenge verification use case.
 *
 * Wraps `adjudicate` with a required expected digest — the digest the chain recorded — and formats
 * the result for CLI output. The domain decides every outcome; this layer wires the call and reports it.
 */

import { hexOf } from '@bell/calibrator/domain/bytes.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';

import {
  adjudicate,
  type AdjudicationResult,
  type CommittedParameterSet,
  type RefitRunner,
} from '../domain/adjudication.js';

/** Verify a committed parameter set against the digest the chain recorded. */
export async function verifyChallenge(input: {
  commitment: CommittedParameterSet;
  expectedDigest: Uint8Array;
  refit: RefitRunner;
  keccak: Keccak;
}): Promise<AdjudicationResult> {
  return adjudicate(input.commitment, input.refit, input.keccak, {
    expectedDigest: input.expectedDigest,
  });
}

/** Format an adjudication result for CLI output. */
export function formatChallengeReport(result: AdjudicationResult): string {
  switch (result.kind) {
    case 'upheld':
      return (
        `kind=upheld ` +
        `premiumDeltaWad=${result.premiumDeltaWad.toString()} ` +
        `digest=0x${hexOf(result.digest)}`
      );
    case 'slashed':
      return `kind=slashed reason=${result.reason} digest=0x${hexOf(result.digest)}`;
    case 'inputs-unavailable':
      return `kind=inputs-unavailable reason=${result.reason}`;
    case 'digest-mismatch':
      return (
        `kind=digest-mismatch ` +
        `expected=0x${hexOf(result.expected)} ` +
        `computed=0x${hexOf(result.computed)}`
      );
  }
}
