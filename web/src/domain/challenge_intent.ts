import { CHALLENGER_BOND } from '@bell/calibrator/domain/constants.js';

import { WebDomainError } from './errors.js';
import { type IntentBatch } from './intents.js';

const NAME_ID_HEX = /^0x[0-9a-fA-F]{64}$/;

export function buildChallenge(input: {
  readonly nameId: string;
  readonly forSession: bigint;
  readonly challengerBond?: bigint;
}): IntentBatch {
  if (!NAME_ID_HEX.test(input.nameId)) {
    throw new WebDomainError('nameId must be 0x followed by 64 hex characters');
  }
  if (input.forSession < 0n) {
    throw new WebDomainError('forSession must be non-negative');
  }

  const challengerBond = input.challengerBond ?? CHALLENGER_BOND;
  if (challengerBond <= 0n) {
    throw new WebDomainError('challengerBond must be positive');
  }

  return {
    kind: 'challenge',
    steps: [
      {
        label: 'Approve premium registry to spend collateral',
        target: 'collateral',
        method: 'approve',
        args: [challengerBond],
      },
      {
        label: 'Challenge committed premium',
        target: 'premium',
        method: 'challenge',
        args: [input.nameId, input.forSession],
      },
    ],
  };
}

/**
 * The arbiter's ruling on a challenged commitment.
 *
 * The ruling is deterministic — the re-fit either matches the committed inputs or it does not — so
 * the arbiter's broadcast is a single `resolve` step with no approvals. The chain enforces that
 * only the arbiter can submit it; the surface gates on the same read so a non-arbiter gets a named
 * refusal rather than an opaque revert.
 */
export function buildResolve(input: {
  readonly nameId: string;
  readonly forSession: bigint;
  /** Whether the committed parameter matches its committed inputs. */
  readonly publisherCorrect: boolean;
}): IntentBatch {
  if (!NAME_ID_HEX.test(input.nameId)) {
    throw new WebDomainError('nameId must be 0x followed by 64 hex characters');
  }
  if (input.forSession < 0n) {
    throw new WebDomainError('forSession must be non-negative');
  }

  return {
    kind: 'resolve',
    steps: [
      {
        label: input.publisherCorrect ? 'Rule publisher correct' : 'Rule publisher slashed',
        target: 'premium',
        method: 'resolve',
        args: [input.nameId, input.forSession, input.publisherCorrect ? 1n : 0n],
      },
    ],
  };
}
