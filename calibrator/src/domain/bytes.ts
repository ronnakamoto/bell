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
 * the whole reason this is a separate type rather than a method. Nothing in `src/` constructs one
 * yet, which is a fact about the port's progress rather than about this type: the Python tests it in
 * `calibrator/tests/unit/test_models.py`, and `calibrator/tests/unit/bytes.test.ts` now tests it here.
 * The two other helpers, `hexOf` and `bytesFromHex`, are exercised by `contract/digest.test.ts` as
 * well, and `bytesEqual` by `settlement/tests/unit/adjudication.test.ts`; `bytes.test.ts` adds the
 * refusal paths and the padding, which nothing else reaches.
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

/**
 * The value of one hex digit, from its character code.
 *
 * **Arithmetic rather than `Number.parseInt`, which is what this used to call.** The domain bans the
 * string-to-number parsers because each produces an IEEE-754 double, and `Number.parseInt` was
 * reachable only because the ban listed `Number.parseFloat` and the bare `parseInt` but not this
 * spelling of it — `DESIGN_NOTES.md` F77. It was never *wrong* here: a hex digit is 0..15 and exact.
 * It was the rule failing open on a spelling nobody had thought of, which is the same shape as F74,
 * and the fix is to stop needing the parser rather than to widen the hole back.
 *
 * Nibble arithmetic also says what hex *means*, where a radix argument only implies it.
 */
function hexDigit(code: number, text: string): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // '0'-'9'
  if (code >= 0x41 && code <= 0x46) return code - 0x37; // 'A'-'F'
  if (code >= 0x61 && code <= 0x66) return code - 0x57; // 'a'-'f'
  throw new DomainError(`not hex: ${text}`);
}

/**
 * Parse a `0x`-prefixed hex string into bytes. Rejects an odd length or a non-hex character.
 *
 * The prefix is optional, because the fixture writes one and a digest read from a log may not. An
 * empty body is zero bytes rather than an error.
 *
 * The odd-length check comes first, so that a malformed length is reported as a malformed length
 * rather than as whichever character happened to be at the boundary. The digit function is the
 * validation — there is no separate scan — so a string is rejected at the first character that is not
 * a hex digit.
 */
export function bytesFromHex(text: string): Uint8Array {
  const body = text.startsWith('0x') ? text.slice(2) : text;
  if (body.length % 2 !== 0) throw new DomainError(`odd-length hex string: ${text}`);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const high = hexDigit(body.charCodeAt(i * 2), text);
    const low = hexDigit(body.charCodeAt(i * 2 + 1), text);
    out[i] = high * 16 + low;
  }
  return out;
}
