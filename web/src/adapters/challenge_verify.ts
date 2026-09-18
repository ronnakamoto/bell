/**
 * A challenge source backed by the settlement file adapters and store re-fit.
 *
 * The composition root the web slice uses for `/challenge`. Everything that can go wrong with
 * the fixtures lives in settlement's adapters; this file wires them, runs `verifyChallenge`, and
 * maps the adjudication result onto the serialisable view the domain owns.
 *
 * Re-fit is `store.window` → `calibrate`, the same path as `make challenge-verify`. Outcomes are
 * never stubbed here.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hexOf } from '@bell/calibrator/domain/bytes.js';
import {
  listChallengeCaseLabels,
  loadChallengeCase,
} from '@bell/settlement/adapters/challenge_case_file.js';
import { loadCommittedInputStore } from '@bell/settlement/adapters/committed_input_store_file.js';
import { nobleKeccak } from '@bell/settlement/adapters/keccak_noble.js';
import { refitFromStore } from '@bell/settlement/adapters/refit_from_store.js';
import { verifyChallenge } from '@bell/settlement/application/verify_challenge.js';
import {
  type AdjudicationResult,
  CommittedParameterSet,
} from '@bell/settlement/domain/adjudication.js';

import { type ChallengeReportView } from '../domain/challenge.js';
import { type ChallengeCaseIdentity, type ChallengeSource } from '../domain/ports.js';

const adapterDir = path.dirname(fileURLToPath(import.meta.url));

/** Path to the committed challenge-case fixture, resolved from the repo root. */
export const CHALLENGE_PATH = path.resolve(adapterDir, '../../../spec/fixtures/challenge.json');

/** Path to the committed-input store fixture, resolved from the repo root. */
export const COMMITTED_INPUTS_PATH = path.resolve(
  adapterDir,
  '../../../spec/fixtures/committed_inputs.json',
);

/**
 * Reads the challenge-case fixture and re-fits from the committed-input store.
 *
 * Paths rather than an in-memory map are the configuration, because the committed fixtures are
 * one document each rather than one-file-per-label.
 */
export class FileChallengeSource implements ChallengeSource {
  readonly casePath: string;
  readonly storePath: string;

  constructor(casePath: string = CHALLENGE_PATH, storePath: string = COMMITTED_INPUTS_PATH) {
    this.casePath = casePath;
    this.storePath = storePath;
  }

  labels(): Promise<readonly string[]> {
    return listChallengeCaseLabels(this.casePath);
  }

  async verify(label: string): Promise<ChallengeReportView> {
    const loaded = await loadChallengeCase(this.casePath, label);
    const store = await loadCommittedInputStore(this.storePath, nobleKeccak);
    const result = await verifyChallenge({
      commitment: new CommittedParameterSet({
        nameId: loaded.nameId,
        forSession: loaded.forSession,
        lambdaWad: loaded.lambdaWad,
        premiumWad: loaded.premiumWad,
        inputsHash: loaded.inputsHash,
      }),
      expectedDigest: loaded.expectedDigest,
      refit: refitFromStore(store, nobleKeccak),
      keccak: nobleKeccak,
    });
    return toChallengeReportView(result);
  }

  async identity(label: string): Promise<ChallengeCaseIdentity> {
    const loaded = await loadChallengeCase(this.casePath, label);
    return {
      nameId: `0x${hexOf(loaded.nameId)}`,
      forSession: loaded.forSession,
    };
  }
}

/** Map settlement adjudication onto the participant-facing view. Hex is `0x` + `hexOf`. */
export function toChallengeReportView(result: AdjudicationResult): ChallengeReportView {
  switch (result.kind) {
    case 'upheld':
      return {
        kind: 'upheld',
        premiumDeltaWad: result.premiumDeltaWad.toString(),
        digest: `0x${hexOf(result.digest)}`,
      };
    case 'slashed':
      return {
        kind: 'slashed',
        reason: result.reason,
        digest: `0x${hexOf(result.digest)}`,
      };
    case 'inputs-unavailable':
      return {
        kind: 'inputs-unavailable',
        reason: result.reason,
      };
    case 'digest-mismatch':
      return {
        kind: 'digest-mismatch',
        expected: `0x${hexOf(result.expected)}`,
        computed: `0x${hexOf(result.computed)}`,
      };
  }
}
