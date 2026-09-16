/**
 * `NameId` and the byte helpers.
 *
 * Two of these tests are ported from `calibrator/tests/unit/test_models.py`, which is where the
 * Python keeps `NameId`: the width guard and the hex form. The other seven are **additions**, because
 * the Python has no equivalent of `hexOf`, `bytesEqual` or `bytesFromHex` — and that is not an
 * oversight in the Python. It calls `bytes.hex()` and compares `bytes` with `==`, and both of those
 * are already correct there: `bytes.hex()` pads every byte to two digits, and `bytes == bytes`
 * compares content. Neither property survives the translation, which is why the three helpers exist
 * and why they need tests of their own rather than only the transitive exercise they get from
 * `contract/digest.test.ts` and `adjudication.test.ts`.
 *
 * This file is separate from `models.test.ts` for the same reason `bytes.ts` is separate from
 * `models.ts` — the seam is real, and the test file mirrors the source file. `models.test.ts` records
 * where the Python's 17 tests went.
 */

import { describe, expect, it } from 'vitest';

import { bytesEqual, bytesFromHex, hexOf, NameId } from '../../src/domain/bytes.js';

/** The Python's `DIGEST`, and the byte a name id is built from in every test below. */
const DIGEST = new Uint8Array(32).fill(0x11);

describe('NameId', () => {
  it('refuses a digest that is not 32 bytes', () => {
    // A name id is the keccak of a symbol, so a short one cannot have come from a hash. Catching it
    // here is what stops a malformed id reaching the commitment preimage, where it would encode into a
    // digest that no honest challenger could reproduce.
    expect(() => new NameId(new Uint8Array(31))).toThrow(/a name id is 32 bytes/);
    expect(() => new NameId(new Uint8Array(33))).toThrow(/a name id is 32 bytes/);
  });

  it('is the zero-prefixed hex form the fixture and the chain both use', () => {
    expect(new NameId(DIGEST).toHex()).toBe(`0x${'11'.repeat(32)}`);
    expect(new NameId(DIGEST).toHex().startsWith('0x')).toBe(true);
    expect(new NameId(DIGEST).toHex()).toHaveLength(66);
  });
});

describe('bytesEqual', () => {
  it('compares bytes by content, where `===` compares references', () => {
    // **This is the port's only translation whose *wrong* form is the one that looks right.**
    // `computed === expected` reads exactly like the Python's `computed == expected` and compiles, and
    // it is `false` for two arrays holding identical bytes that were not created by the same
    // expression. In `adjudication.ts` that reports `DigestMismatch` for a digest that does reproduce,
    // so a challenger whose challenge cannot lose is told it cannot win.
    const computed = bytesFromHex(`0x${'ab'.repeat(32)}`);
    const expected = new Uint8Array(32).fill(0xab);

    expect(computed).not.toBe(expected); // reference equality, which is the trap
    expect(bytesEqual(computed, expected)).toBe(true);
  });

  it('is true for two arrays that are the same object, which is the easy half', () => {
    expect(bytesEqual(DIGEST, DIGEST)).toBe(true);
  });

  it('is false for equal-length arrays holding different bytes', () => {
    const other = new Uint8Array(32).fill(0x11);
    other[31] = 0x12; // the last byte only, so a prefix comparison would pass
    expect(bytesEqual(DIGEST, other)).toBe(false);
  });

  it('is false for arrays of different lengths', () => {
    // Checked before the loop rather than by it: `left[i]` on a shorter `right` is `undefined`, and
    // `undefined !== 0` is `true`, so the loop would return the right answer for the wrong reason and
    // would read past the end of an empty array.
    expect(bytesEqual(DIGEST, new Uint8Array(31))).toBe(false);
    expect(bytesEqual(new Uint8Array(0), DIGEST)).toBe(false);
  });
});

describe('hexOf', () => {
  it('pads every byte to two digits', () => {
    // `(0x0f).toString(16)` is `'f'`, and a hex string built that way has an ambiguous length — which
    // is the form the fixture and the chain both reject.
    expect(hexOf(new Uint8Array([0x0f]))).toBe('0f');
    expect(hexOf(new Uint8Array([0x00]))).toBe('00');
    expect(hexOf(new Uint8Array([0x00, 0x01, 0xff]))).toBe('0001ff');
    expect(hexOf(new Uint8Array(0))).toBe('');
  });
});

describe('bytesFromHex', () => {
  it('round-trips a digest, with and without the prefix', () => {
    expect(Array.from(bytesFromHex(`0x${hexOf(DIGEST)}`))).toEqual(Array.from(DIGEST));
    expect(Array.from(bytesFromHex(hexOf(DIGEST)))).toEqual(Array.from(DIGEST));
  });

  it('reads both hex cases, and an empty body as no bytes', () => {
    // The uppercase branch is not decoration: the contract fixtures are lowercase, so nothing else in
    // the suite would notice if it stopped working.
    expect(Array.from(bytesFromHex('0x0f'))).toEqual([0x0f]);
    expect(Array.from(bytesFromHex('0xAB'))).toEqual([0xab]);
    expect(Array.from(bytesFromHex('0x'))).toEqual([]);
    expect(Array.from(bytesFromHex(''))).toEqual([]);
  });

  it('refuses an odd-length string', () => {
    // Half a byte is not a byte, and silently dropping the nibble would shift every byte after it.
    expect(() => bytesFromHex('0x0')).toThrow(/odd-length hex string/);
    expect(() => bytesFromHex('abc')).toThrow(/odd-length hex string/);
  });

  it('refuses a character that is not hex', () => {
    expect(() => bytesFromHex('0xzz')).toThrow(/not hex/);
    expect(() => bytesFromHex('0x0g')).toThrow(/not hex/);
    expect(() => bytesFromHex('0x 0')).toThrow(/not hex/);
  });
});
