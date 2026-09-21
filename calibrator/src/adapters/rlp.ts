/**
 * Minimal RLP encoding for the transaction types this tree signs.
 *
 * A legacy transaction is a list of byte strings — nonce, gasPrice, gasLimit, to, value, data —
 * plus the EIP-155 suffix `[chainId, 0, 0]` for signing. Every element is a byte string or a list
 * of byte strings, so the encoder needs only the two rules that shape those: a single byte below
 * 0x80 encodes as itself, and a byte string of length n encodes as a length prefix plus the bytes
 * (0x80 + n for n < 56). Nested lists recurse with the list prefix 0xc0. That is the whole of RLP
 * for a legacy tx, and it is kept here rather than as a dependency because the surface is that
 * small and the vector test pins it.
 */

/** Encode one byte string, or a list of encoded elements, as RLP bytes. */
export function rlpEncode(value: Uint8Array | readonly Uint8Array[]): Uint8Array {
  if (value instanceof Uint8Array) {
    return encodeBytes(value);
  }
  const payload = concat(value.map((element) => rlpEncode(element)));
  return concat([prefix(payload.length, 0xc0), payload]);
}

function encodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] !== undefined && bytes[0] < 0x80) {
    return bytes;
  }
  return concat([prefix(bytes.length, 0x80), bytes]);
}

/** The RLP length prefix for a payload of `length`, with the base offset for the type. */
function prefix(length: number, base: number): Uint8Array {
  if (length < 56) {
    return Uint8Array.of(base + length);
  }
  const lengthBytes = bigEndian(BigInt(length));
  return concat([Uint8Array.of(base + 55 + lengthBytes.length), lengthBytes]);
}

/** A big-endian byte string of `value`, with no leading zero bytes; RLP encodes 0 as empty. */
export function bigEndian(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array(0);
  const hex = value.toString(16);
  const padded = hex.length % 2 === 1 ? `0${hex}` : hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

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
