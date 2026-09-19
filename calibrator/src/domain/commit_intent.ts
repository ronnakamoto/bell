/**
 * Publisher commit intent: approve the bond, then call `PremiumRegistry.commit`.
 *
 * Pure description of the two calls a wallet would send. No broadcast — same role as the web's
 * `buildChallenge`, on the publisher side of the bond.
 */

import { MIN_PUBLISHER_BOND } from './constants.js';
import { DomainError } from './models.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export type CommitIntentTarget = 'collateral' | 'premium';

export interface CommitIntentStep {
  readonly label: string;
  readonly target: CommitIntentTarget;
  readonly method: string;
  readonly args: readonly (bigint | string)[];
}

export interface CommitIntentBatch {
  readonly kind: 'commit';
  readonly steps: readonly CommitIntentStep[];
}

/**
 * Build the two-step commit batch: collateral approve, then premium.commit.
 *
 * `nameId` and `inputsHash` are `0x`-prefixed 32-byte hex (case-insensitive hex digits). Bond defaults
 * to `MIN_PUBLISHER_BOND`. Zero or negative λ / premium / bond are refused — the registry would revert
 * them, and the preview exists so a publisher finds that out before spending gas.
 */
export function buildCommit(input: {
  readonly nameId: string;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly inputsHash: string;
  readonly publisherBond?: bigint;
}): CommitIntentBatch {
  if (!HEX32.test(input.nameId)) {
    throw new DomainError('nameId must be 0x followed by 64 hex characters');
  }
  if (!HEX32.test(input.inputsHash)) {
    throw new DomainError('inputsHash must be 0x followed by 64 hex characters');
  }
  if (input.forSession < 0n) {
    throw new DomainError('forSession must be non-negative');
  }
  if (input.lambdaWad <= 0n) {
    throw new DomainError('lambdaWad must be positive');
  }
  if (input.premiumWad <= 0n) {
    throw new DomainError('premiumWad must be positive');
  }

  const publisherBond = input.publisherBond ?? MIN_PUBLISHER_BOND;
  if (publisherBond <= 0n) {
    throw new DomainError('publisherBond must be positive');
  }

  return {
    kind: 'commit',
    steps: [
      {
        label: 'Approve premium registry to spend collateral',
        target: 'collateral',
        method: 'approve',
        args: [publisherBond],
      },
      {
        label: 'Commit parameter set',
        target: 'premium',
        method: 'commit',
        args: [input.nameId, input.forSession, input.lambdaWad, input.premiumWad, input.inputsHash],
      },
    ],
  };
}
