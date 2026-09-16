/**
 * Challenge adjudication.
 *
 * Ported from `settlement/tests/unit/test_adjudication.py`, which has 18 tests; this file has 18.
 *
 * The adjudication is the mechanism that makes a challenge a verification rather than a matter of
 * testimony, so every outcome it can produce is asserted: upheld, slashed on the leverage, slashed on
 * the premium, inputs unavailable, and a digest that does not reproduce.
 *
 * **Three departures, all forced.**
 *
 *  - **`adjudicate` is awaited.** The port's `RefitRunner` resolves a promise, because the only real
 *    implementation reads a `CommittedInputStore`, which is a promise-returning port. An un-awaited
 *    call would let "the digest is checked before the fit is re-run" pass against a re-run that had
 *    already happened.
 *  - **The reference keccak is `@noble/hashes`**, where the Python uses `Crypto.Hash.keccak`. Same
 *    convention as the calibrator's suites, and for the same reason: Node's `crypto` hashes NIST
 *    SHA3-256, which agrees with Ethereum's keccak256 on nothing.
 *  - **`bytes` is `Uint8Array`.** `expect(correct).toEqual(correct)` compares content, so the two
 *    digest assertions in this file are the ones that would fail under reference equality — which is
 *    precisely the trap `bytesEqual` exists to close, and this file is where it is closed.
 *
 * The variant assertions are helpers that throw rather than `expect`s that fail, mirroring the
 * Python's `assert isinstance(result, PublisherUpheld)` followed by attribute access: a test that
 * reaches the fields with the wrong variant has already failed, and the message says which variant it
 * got instead.
 */

import { WAD } from '@bell/calibrator/domain/constants.js';
import { commitmentDigest } from '@bell/calibrator/domain/digest.js';
import { Wad } from '@bell/calibrator/domain/models.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

import {
  adjudicate,
  type AdjudicationResult,
  CommittedParameterSet,
  digestMatches,
  type DigestMismatch,
  type InputsUnavailable,
  PREMIUM_TOLERANCE_WAD,
  premiumToleranceFromPrecision,
  type PublisherSlashed,
  type PublisherUpheld,
  type RefitRunner,
} from '../../src/domain/adjudication.js';

const referenceKeccak: Keccak = (data) => keccak_256(data);

/** UTF-8 bytes of a literal, which is what the Python's `b"..."` is. */
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const NAME_ID = referenceKeccak(utf8('NVDA'));
const INPUTS_HASH = referenceKeccak(utf8('NVDA/E/504/canonical-rows'));

const LAMBDA_WAD = 15n * WAD;

/** A decimal literal at WAD scale, exactly, the way the Python's `int(Decimal(v) * WAD)` does it. */
const wadOf = (value: string): bigint => Wad.fromStr(value).raw;

const PREMIUM_WAD = wadOf('0.1740');

/** 32 zero bytes, which is what the Python writes as `b"\x00" * 32`. */
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

/** A re-run that always produces the same parameter set. */
function refitReturning(lam: bigint, premium: bigint): RefitRunner {
  return () => Promise.resolve({ lambdaWad: lam, premiumWad: premium });
}

const refitUnavailable: RefitRunner = () => Promise.resolve(undefined);

function expectUpheld(result: AdjudicationResult): PublisherUpheld {
  if (result.kind !== 'upheld') {
    throw new Error(`the adjudication reported ${result.kind}, not upheld`);
  }
  return result;
}

function expectSlashed(result: AdjudicationResult): PublisherSlashed {
  if (result.kind !== 'slashed') {
    throw new Error(`the adjudication reported ${result.kind}, not slashed`);
  }
  return result;
}

function expectUnavailable(result: AdjudicationResult): InputsUnavailable {
  if (result.kind !== 'inputs-unavailable') {
    throw new Error(`the adjudication reported ${result.kind}, not inputs-unavailable`);
  }
  return result;
}

function expectMismatch(result: AdjudicationResult): DigestMismatch {
  if (result.kind !== 'digest-mismatch') {
    throw new Error(`the adjudication reported ${result.kind}, not digest-mismatch`);
  }
  return result;
}

describe('tolerance derivation', () => {
  it('the premium tolerance is half a unit in the last published place', () => {
    // Four decimal places, so 5e-5. Derived rather than chosen, and asserted against the constant so
    // a change to one without the other fails here rather than in production.
    expect(premiumToleranceFromPrecision(4)).toBe(PREMIUM_TOLERANCE_WAD);
  });

  it('a coarser precision gives a wider tolerance', () => {
    expect(premiumToleranceFromPrecision(2)).toBeGreaterThan(premiumToleranceFromPrecision(4));
  });

  it('a negative precision is refused', () => {
    expect(() => premiumToleranceFromPrecision(-1)).toThrow(/precision/);
  });
});

describe('upheld', () => {
  it('an exact match is upheld', async () => {
    const result = await adjudicate(
      commitment(),
      refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      referenceKeccak,
    );
    expect(expectUpheld(result).premiumDeltaWad).toBe(0n);
  });

  it('a match inside the published precision is upheld', async () => {
    // The published premium carries a rounding uncertainty of its own, so a re-run inside it is
    // consistent with the published number.
    const drifted = PREMIUM_WAD + PREMIUM_TOLERANCE_WAD - 1n;
    const result = await adjudicate(
      commitment(),
      refitReturning(LAMBDA_WAD, drifted),
      referenceKeccak,
    );
    expect(expectUpheld(result).premiumDeltaWad).toBe(PREMIUM_TOLERANCE_WAD - 1n);
  });

  it('the upheld result carries the digest', async () => {
    const entry = commitment();
    const result = await adjudicate(
      entry,
      refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      referenceKeccak,
    );
    expect(expectUpheld(result).digest).toEqual(expectedDigest(entry));
  });
});

describe('slashed', () => {
  it('a leverage off the lattice is slashed', async () => {
    // The leverage is an integer on the harmonic ladder and is published exactly, so a tolerance on
    // it would be a tolerance on which instrument was listed.
    const result = await adjudicate(
      commitment(),
      refitReturning(LAMBDA_WAD + 1n, PREMIUM_WAD),
      referenceKeccak,
    );
    expect(expectSlashed(result).reason).toContain('lattice');
  });

  it('a premium outside the published precision is slashed', async () => {
    const result = await adjudicate(
      commitment(),
      refitReturning(LAMBDA_WAD, PREMIUM_WAD + PREMIUM_TOLERANCE_WAD + 1n),
      referenceKeccak,
    );
    expect(expectSlashed(result).reason).toContain('premium');
  });

  it('the slash is symmetric in the sign of the error', async () => {
    // A publisher that overstates and one that understates are both wrong. An asymmetric test would
    // let a publisher shade its premium in whichever direction the comparison allowed.
    const high = await adjudicate(
      commitment(),
      refitReturning(LAMBDA_WAD, PREMIUM_WAD + 10n ** 15n),
      referenceKeccak,
    );
    const low = await adjudicate(
      commitment(),
      refitReturning(LAMBDA_WAD, PREMIUM_WAD - 10n ** 15n),
      referenceKeccak,
    );
    expect(expectSlashed(high).kind).toBe('slashed');
    expect(expectSlashed(low).kind).toBe('slashed');
  });

  it('the leverage is checked before the premium', async () => {
    // Both wrong: the reason names the leverage, because the leverage is the coarser error and the one
    // that changes the instrument.
    const result = await adjudicate(
      commitment(),
      refitReturning(LAMBDA_WAD + 5n, PREMIUM_WAD + 10n ** 16n),
      referenceKeccak,
    );
    expect(expectSlashed(result).reason).toContain('lattice');
  });
});

describe('no ruling', () => {
  it('unavailable inputs are not a slash', async () => {
    // The distinction matters: a publisher whose inputs are missing has not been shown to have
    // published a wrong parameter, and slashing it would make the bond forfeitable by anyone who can
    // suppress a data source.
    const result = await adjudicate(commitment(), refitUnavailable, referenceKeccak);
    expect(expectUnavailable(result).reason).toContain('could not be retrieved');
  });

  it('a digest that does not reproduce is a mismatch', async () => {
    const entry = commitment();
    const result = await adjudicate(
      entry,
      refitReturning(LAMBDA_WAD, PREMIUM_WAD),
      referenceKeccak,
      { expectedDigest: ZERO_DIGEST },
    );
    expect(expectMismatch(result).computed).toEqual(expectedDigest(entry));
  });

  it('the digest is checked before the fit is re-run', async () => {
    // A commitment whose fields do not hash to its recorded digest is not the commitment the
    // publisher made, so nothing downstream of it means anything -- and the fit must not be run
    // against inputs that the digest says are not the committed ones.
    const mustNotRun: RefitRunner = () => {
      throw new Error('the fit was re-run before the digest was verified');
    };

    const result = await adjudicate(commitment(), mustNotRun, referenceKeccak, {
      expectedDigest: ZERO_DIGEST,
    });
    expect(result.kind).toBe('digest-mismatch');
  });

  it('a correct digest passes the check', () => {
    const entry = commitment();
    expect(digestMatches(entry, expectedDigest(entry), referenceKeccak)).toBe(true);
  });

  it('a wrong digest fails the check', () => {
    // Exposed separately because a challenger needs it *before* posting a bond: a commitment whose
    // digest does not reproduce is a challenge that cannot lose.
    expect(digestMatches(commitment(), ZERO_DIGEST, referenceKeccak)).toBe(false);
  });
});

describe('the commitment value object', () => {
  it('a short name id is refused', () => {
    expect(
      () =>
        new CommittedParameterSet({
          nameId: utf8('short'),
          forSession: 1n,
          lambdaWad: LAMBDA_WAD,
          premiumWad: PREMIUM_WAD,
          inputsHash: INPUTS_HASH,
        }),
    ).toThrow(/nameId/);
  });

  it('a short inputs hash is refused', () => {
    expect(
      () =>
        new CommittedParameterSet({
          nameId: NAME_ID,
          forSession: 1n,
          lambdaWad: LAMBDA_WAD,
          premiumWad: PREMIUM_WAD,
          inputsHash: utf8('short'),
        }),
    ).toThrow(/inputsHash/);
  });

  it('a negative session is refused', () => {
    expect(
      () =>
        new CommittedParameterSet({
          nameId: NAME_ID,
          forSession: -1n,
          lambdaWad: LAMBDA_WAD,
          premiumWad: PREMIUM_WAD,
          inputsHash: INPUTS_HASH,
        }),
    ).toThrow(/forSession/);
  });
});
