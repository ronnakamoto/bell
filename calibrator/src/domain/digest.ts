/**
 * The commitment digest: the cross-language contract of paper Appendix B.
 *
 * Two things cross the language boundary in this protocol and both are specified once and tested on
 * both sides. This module is the second of them. The Solidity side is
 * `keccak256(abi.encode(nameId, forSession, lambdaWad, premiumWad, inputsHash))`; this module
 * reproduces that byte for byte, and `tests/contract/digest.test.ts` plus
 * `contracts/test/differential/Digest.t.sol` both read the same fixture from `spec/digest.json` and
 * assert agreement.
 *
 * The hash itself is injected rather than imported, because `domain/` may not depend on a hashing
 * library. This module owns the *preimage layout* — the part that has to be identical across
 * languages — and the adapter owns the primitive. See `ports.ts` for why the primitive cannot be
 * Node's `crypto`.
 */

import { DIGEST_BYTES, DomainError, type SessionKind, type Symbol } from './models.js';

const UINT64_BYTES = 8;
const UINT256_BYTES = 32;
const UINT32_BYTES = 4;
const BYTES32_BYTES = 32;
const MAX_UINT32 = 2 ** 32;

/** The most source identifiers the one-byte count can hold. */
const MAX_SOURCE_IDS = 255;

/** The most bytes the one-byte length prefix can hold. */
const MAX_SOURCE_ID_BYTES = 255;

/**
 * `value` as `length` big-endian bytes, refusing anything that does not fit.
 *
 * The refusals are the point. A silent truncation here would produce a preimage that hashes to
 * something plausible and matches nothing, which is the failure mode this whole module exists to
 * prevent — and it is indistinguishable from a dishonest publisher when a challenge fails.
 */
function uintToBytes(value: bigint, length: number, label: string): Uint8Array {
  if (value < 0n) throw new DomainError(`${label} cannot be negative`);
  if (value >= 1n << BigInt(length * 8)) {
    throw new DomainError(`${label} does not fit ${String(length)} bytes`);
  }
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** `count` as a single byte, refusing anything above 255. */
function byteOf(count: number, label: string): Uint8Array {
  if (!Number.isInteger(count) || count < 0 || count > 255) {
    throw new DomainError(`${label} must fit a single byte, got ${String(count)}`);
  }
  return Uint8Array.of(count);
}

/** Concatenate byte arrays in order. */
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The 160-byte preimage of the commitment digest, in `abi.encode` order.
 *
 * `abi.encode` pads each argument to 32 bytes and leaves fixed-size types unpadded in value, so the
 * layout is exactly the concatenation of the big-endian encodings below. This is spelled out rather
 * than delegated to an ABI library because a library that changes its encoding rules would silently
 * break the contract with the chain, and because the layout is short enough to check by reading it.
 *
 * Layout, 32 + 32 + 32 + 32 + 32 = 160 bytes:
 *
 *     [  0,  32)  nameId       bytes32
 *     [ 32,  64)  forSession   uint64, right-aligned in 32 bytes
 *     [ 64,  96)  lambdaWad    uint256
 *     [ 96, 128)  premiumWad   uint256
 *     [128, 160)  inputsHash   bytes32
 */
export function commitmentPreimage(
  nameId: Uint8Array,
  forSession: bigint,
  lambdaWad: bigint,
  premiumWad: bigint,
  inputsHash: Uint8Array,
): Uint8Array {
  if (nameId.length !== BYTES32_BYTES) {
    throw new DomainError('nameId must be 32 bytes');
  }
  if (inputsHash.length !== BYTES32_BYTES) {
    throw new DomainError('inputsHash must be 32 bytes');
  }
  if (forSession < 0n || forSession >= 1n << BigInt(UINT64_BYTES * 8)) {
    throw new DomainError('forSession must fit a uint64');
  }
  if (lambdaWad < 0n || premiumWad < 0n) {
    throw new DomainError('a uint256 parameter cannot be negative');
  }

  return concat([
    nameId,
    // `abi.encode` right-aligns a uint64 in a 32-byte word, which is the same as encoding the value
    // directly into 32 bytes: the leading 24 bytes are zero by construction, because the range check
    // above has already established the value fits in eight.
    uintToBytes(forSession, UINT256_BYTES, 'forSession'),
    uintToBytes(lambdaWad, UINT256_BYTES, 'lambdaWad'),
    uintToBytes(premiumWad, UINT256_BYTES, 'premiumWad'),
    inputsHash,
  ]);
}

/** `keccak256` of `commitmentPreimage`, i.e. the value the registry stores and a challenger recomputes. */
export function commitmentDigest(
  keccak: (data: Uint8Array) => Uint8Array,
  nameId: Uint8Array,
  forSession: bigint,
  lambdaWad: bigint,
  premiumWad: bigint,
  inputsHash: Uint8Array,
): Uint8Array {
  return keccak(commitmentPreimage(nameId, forSession, lambdaWad, premiumWad, inputsHash));
}

/**
 * The canonical serialisation of the raw inputs a fit consumed.
 *
 * This is what makes a challenge a verification rather than a matter of testimony: any party can
 * re-run the committed fit from these inputs and check the committed parameter against the result.
 * Without it the mechanism degrades to trusting the publisher, which is the exact failure the
 * commitment exists to prevent.
 *
 * The brief names the contents — "window, session kind, source ids, row count, and a digest of the
 * rows" — but does not define the serialisation, and a cross-language contract needs an exact
 * definition. This one is fixed here and mirrored by the Solidity fixture test:
 *
 *     uint32  windowSessions            big-endian
 *     uint8   session code length
 *     bytes   session code              the SessionKind value, ASCII
 *     uint8   source count, then for each: uint8 length + UTF-8 bytes
 *     uint32  rowCount                  big-endian
 *     bytes32 rowsDigest
 *
 * Variable-length source identifiers are length-prefixed so that `["AB", "C"]` and `["A", "BC"]`
 * cannot collide — an ambiguity that would let a publisher commit one input set and be challenged
 * against another.
 */
export function inputsPreimage(
  windowSessions: number,
  session: SessionKind,
  sourceIds: readonly string[],
  rowCount: number,
  rowsDigest: Uint8Array,
): Uint8Array {
  if (!Number.isInteger(windowSessions) || windowSessions < 0 || windowSessions >= MAX_UINT32) {
    throw new DomainError('windowSessions must fit a uint32');
  }
  if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount >= MAX_UINT32) {
    throw new DomainError('rowCount must fit a uint32');
  }
  if (rowsDigest.length !== BYTES32_BYTES) {
    throw new DomainError('rowsDigest must be 32 bytes');
  }
  if (sourceIds.length > MAX_SOURCE_IDS) {
    throw new DomainError('at most 255 source identifiers');
  }

  const encodedSources: Uint8Array[] = [];
  for (const sourceId of sourceIds) {
    // Measured in UTF-8 bytes, not characters. A guard that counted characters would admit a
    // 200-character identifier of 3-byte characters, which is 600 bytes and overflows the prefix.
    const payload = new TextEncoder().encode(sourceId);
    if (payload.length > MAX_SOURCE_ID_BYTES) {
      throw new DomainError(`source identifier too long: ${JSON.stringify(sourceId)}`);
    }
    encodedSources.push(byteOf(payload.length, 'source identifier length'), payload);
  }

  const sessionCode = new TextEncoder().encode(session);
  return concat([
    uintToBytes(BigInt(windowSessions), UINT32_BYTES, 'windowSessions'),
    byteOf(sessionCode.length, 'session code length'),
    sessionCode,
    byteOf(sourceIds.length, 'source identifier count'),
    ...encodedSources,
    uintToBytes(BigInt(rowCount), UINT32_BYTES, 'rowCount'),
    rowsDigest,
  ]);
}

/** `keccak256` of `inputsPreimage`. */
export function inputsHash(
  keccak: (data: Uint8Array) => Uint8Array,
  windowSessions: number,
  session: SessionKind,
  sourceIds: readonly string[],
  rowCount: number,
  rowsDigest: Uint8Array,
): Uint8Array {
  return keccak(inputsPreimage(windowSessions, session, sourceIds, rowCount, rowsDigest));
}

/**
 * `keccak256(bytes(symbol))` — a `bytes32`, not a string.
 *
 * Hashing the ticker rather than storing it keeps the commitment a fixed-width value, and the
 * domain's `Symbol` validation is what stops a non-canonical ticker reaching this point.
 */
export function nameId(keccak: (data: Uint8Array) => Uint8Array, symbol: Symbol): Uint8Array {
  return keccak(symbol.toBytes());
}

/** Re-exported so a caller does not have to reach into `models` for the width it must supply. */
export { DIGEST_BYTES };
