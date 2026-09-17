/**
 * Challenge verification use case.
 *
 * Wraps `adjudicate` with a required expected digest and formats the result for CLI output.
 * The domain already decides every outcome; this layer wires the call and reports it.
 */

import { WAD } from '@bell/calibrator/domain/constants.js';
import { commitmentDigest } from '@bell/calibrator/domain/digest.js';
import { Wad } from '@bell/calibrator/domain/models.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

import {
  formatChallengeReport,
  verifyChallenge,
} from '../../src/application/verify_challenge.js';
import {
  type AdjudicationResult,
  CommittedParameterSet,
  PREMIUM_TOLERANCE_WAD,
  type RefitRunner,
} from '../../src/domain/adjudication.js';

const referenceKeccak: Keccak = (data) => keccak_256(data);

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const NAME_ID = referenceKeccak(utf8('NVDA'));
const INPUTS_HASH = referenceKeccak(utf8('NVDA/E/504/canonical-rows'));

const LAMBDA_WAD = 15n * WAD;

const wadOf = (value: string): bigint => Wad.fromStr(value).raw;

const PREMIUM_WAD = wadOf('0.1740');

const ZERO_DIGEST = new Uint8Array(32);

function commitment(
  options: { lam?: bigint; premium?: bigint; inputsHash?: Uint8Array } = {},
): CommittedParameterSet {
  return new CommittedParameterSet({
    nameId: NAME_ID,
    forSession: 42n,
    lambdaWad: options.lam ?? LAMBDA_WAD,
    premiumWad: options.premium ?? PREMIUM_WAD,
    inputsHash: options.inputsHash ?? INPUTS_HASH,
  });
}

function expectedDigest(entry: CommittedParameterSet): Uint8Array {
  return commitmentDigest(
    referenceKeccak,
    entry.nameId,
    entry.forSession,
    entry.lambdaWad,
    entry.premiumWad,
    entry.inputsHash,
  );
}

function refitReturning(lam: bigint, premium: bigint): RefitRunner {
  return () => Promise.resolve({ lambdaWad: lam, premiumWad: premium });
}

const refitUnavailable: RefitRunner = () => Promise.resolve(undefined);

describe('verifyChallenge', () => {
  it('an exact match is upheld', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: expectedDigest(entry),
      refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      keccak: referenceKeccak,
    });
    expect(result.kind).toBe('upheld');
  });

  it('a digest that does not reproduce is a mismatch', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: ZERO_DIGEST,
      refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      keccak: referenceKeccak,
    });
    expect(result.kind).toBe('digest-mismatch');
  });

  it('unavailable inputs are not a slash', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: expectedDigest(entry),
      refit: refitUnavailable,
      keccak: referenceKeccak,
    });
    expect(result.kind).toBe('inputs-unavailable');
  });

  it('a premium outside the published precision is slashed', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: expectedDigest(entry),
      refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD + PREMIUM_TOLERANCE_WAD + 1n),
      keccak: referenceKeccak,
    });
    expect(result.kind).toBe('slashed');
  });
});

describe('formatChallengeReport', () => {
  it('includes the kind as a clear token', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: expectedDigest(entry),
      refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      keccak: referenceKeccak,
    });
    expect(formatChallengeReport(result)).toContain('kind=upheld');
  });

  it('includes the premium delta when upheld', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: expectedDigest(entry),
      refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      keccak: referenceKeccak,
    });
    expect(formatChallengeReport(result)).toContain('premiumDeltaWad=0');
  });

  it('includes the reason when slashed', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: expectedDigest(entry),
      refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD + PREMIUM_TOLERANCE_WAD + 1n),
      keccak: referenceKeccak,
    });
    const report = formatChallengeReport(result);
    expect(report).toContain('kind=slashed');
    if (result.kind === 'slashed') {
      expect(report).toContain(result.reason);
    }
  });

  it('includes the reason when inputs are unavailable', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: expectedDigest(entry),
      refit: refitUnavailable,
      keccak: referenceKeccak,
    });
    const report = formatChallengeReport(result);
    expect(report).toContain('kind=inputs-unavailable');
    if (result.kind === 'inputs-unavailable') {
      expect(report).toContain(result.reason);
    }
  });

  it('includes expected and computed digests on mismatch', async () => {
    const entry = commitment();
    const result = await verifyChallenge({
      commitment: entry,
      expectedDigest: ZERO_DIGEST,
      refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      keccak: referenceKeccak,
    });
    const report = formatChallengeReport(result);
    expect(report).toContain('kind=digest-mismatch');
    if (result.kind === 'digest-mismatch') {
      expect(report).toContain('expected=');
      expect(report).toContain('computed=');
    }
  });

  it('covers every adjudication kind', async () => {
    const kinds = new Set<string>();
    const cases: AdjudicationResult[] = [
      await verifyChallenge({
        commitment: commitment(),
        expectedDigest: expectedDigest(commitment()),
        refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD),
        keccak: referenceKeccak,
      }),
      await verifyChallenge({
        commitment: commitment(),
        expectedDigest: ZERO_DIGEST,
        refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD),
        keccak: referenceKeccak,
      }),
      await verifyChallenge({
        commitment: commitment(),
        expectedDigest: expectedDigest(commitment()),
        refit: refitUnavailable,
        keccak: referenceKeccak,
      }),
      await verifyChallenge({
        commitment: commitment(),
        expectedDigest: expectedDigest(commitment()),
        refit: refitReturning(LAMBDA_WAD, PREMIUM_WAD + PREMIUM_TOLERANCE_WAD + 1n),
        keccak: referenceKeccak,
      }),
    ];
    for (const result of cases) {
      kinds.add(result.kind);
      expect(formatChallengeReport(result)).toContain(`kind=${result.kind}`);
    }
    expect(kinds).toEqual(
      new Set(['upheld', 'digest-mismatch', 'inputs-unavailable', 'slashed']),
    );
  });
});
