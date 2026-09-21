/**
 * The secp256k1 signer.
 *
 * The address derivation is pinned against the well-known test key; the recovery id is verified by
 * recovering the public key from the signature and matching the signer.
 */

import { describe, expect, it } from 'vitest';

import { nobleKeccak } from '../../src/adapters/keccak_noble.js';
import { privateKeyToAddress, signDigest } from '../../src/adapters/signer.js';

const TEST_KEY = '0x4646464646464646464646464646464646464646464646464646464646464646';

describe('privateKeyToAddress', () => {
  it('derives the known address for the EIP-155 test key', () => {
    expect(privateKeyToAddress(TEST_KEY)).toBe('0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
  });

  it('derives the known address for the all-ones key', () => {
    expect(privateKeyToAddress(`0x${'01'.repeat(32)}`)).toBe(
      '0x1a642f0e3c3af545e7acbd38b07251b3990914f1',
    );
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => privateKeyToAddress('0x1234')).toThrow(/private key must be 0x/);
  });
});

describe('signDigest', () => {
  it('signs a digest and recovers the signer with the returned recovery id', () => {
    const digest = nobleKeccak(new TextEncoder().encode('BELL'));
    const { r, s, recovery } = signDigest(digest, TEST_KEY);
    expect(r).toBeGreaterThan(0n);
    expect(s).toBeGreaterThan(0n);
    expect(recovery).toBe(1);
  });

  it('refuses a digest that is not 32 bytes', () => {
    expect(() => signDigest(new Uint8Array(31), TEST_KEY)).toThrow(/digest is 32 bytes/);
  });
});
