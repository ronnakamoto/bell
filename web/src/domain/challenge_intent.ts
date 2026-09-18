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
