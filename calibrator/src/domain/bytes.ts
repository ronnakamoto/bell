/**
 * Byte-array helpers, and the one domain type built from a hash.
 *
 * Split out of `models.ts` when that file crossed the 400-line limit (§8.1). The seam is a real one
 * rather than an arbitrary cut at a line number: everything here operates on a `Uint8Array`, and
 * nothing here knows what a `Wad` or a `SessionKind` is. `models.ts` keeps `DIGEST_BYTES` and
 * `DomainError`, so this module depends on it and not the other way round — the edge is one-way,
 * which is what keeps the `no-circular` rule satisfied rather than merely quiet.
 *
 * `NameId` is the only *type* here. It is constructed by the adapter that owns a hash function
 * rather than by `Symbol` itself, because `domain/` may not depend on a hashing library — the port is
 * the whole reason this is a separate type rather than a method. Nothing imports it yet: the Python
 * tests it in `calibrator/tests/unit/test_models.py` and there is no `models.test.ts`, so it is
 * awaiting A8 rather than dead.
 */

import { DIGEST_BYTES, DomainError } from './models.js';

/**
 * `keccak256(bytes(symbol))`, as a 32-byte value.
 */
export class NameId {
  readonly digest: Uint8Array;

  constructor(digest: Uint8Array) {
    if (digest.length !== DIGEST_BYTES) {
      throw new DomainError(`a name id is 32 bytes, got ${String(digest.length)}`);
    }
    this.digest = digest;
  }

  /** `0x`-prefixed lowercase hex, the form the fixture and the Solidity side both use. */
  toHex(): string {
    return `0x${hexOf(this.digest)}`;
  }
}

/** Lowercase hex of a byte array, without a prefix. */
export function hexOf(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Whether two byte arrays hold the same bytes.
 *
 * **`===` on two `Uint8Array`s is reference equality, and Python's `bytes == bytes` is not.** This
 * is the port's only translation whose *wrong* form is the one that looks right: `computed ===
 * expected` reads exactly like the Python's `computed == expected` and compiles, and it is `false`
 * for two arrays holding identical bytes that were not created by the same expression. In
 * `adjudication.ts` that turns a digest that does reproduce into a reported `DigestMismatch` — so a
 * challenger whose challenge cannot lose is told it cannot win, and the mechanism that makes a
 * challenge a verification degrades back to testimony.
 *
 * Named and exported rather than inlined at the two call sites, because the failure is a *shape* a
 * reader has to recognise and `bytesEqual(a, b)` cannot be misread the way `a === b` can.
 */
export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/** Parse a `0x`-prefixed hex string into bytes. Rejects an odd length or a non-hex character. */
export function bytesFromHex(text: string): Uint8Array {
  const body = text.startsWith('0x') ? text.slice(2) : text;
  if (body.length % 2 !== 0) throw new DomainError(`odd-length hex string: ${text}`);
  if (!/^[0-9a-fA-F]*$/.test(body)) throw new DomainError(`not hex: ${text}`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
