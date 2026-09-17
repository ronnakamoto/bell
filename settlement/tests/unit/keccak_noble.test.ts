/**
 * The settlement keccak adapter.
 *
 * Domain owns the preimage; this module owns the primitive. The empty-input vector is the one that
 * distinguishes original Keccak from NIST SHA3-256.
 */

import { hexOf } from '@bell/calibrator/domain/bytes.js';
import { describe, expect, it } from 'vitest';

import { nobleKeccak } from '../../src/adapters/keccak_noble.js';

describe('nobleKeccak', () => {
  it('hashes the empty input as original keccak-256, not NIST SHA3', () => {
    expect(hexOf(nobleKeccak(new Uint8Array()))).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });
});
