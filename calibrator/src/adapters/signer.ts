/**
 * The secp256k1 signer for CLI broadcasts.
 *
 * Derives the Ethereum address from a private key and signs a 32-byte digest with recovery id, so
 * a caller can build an EIP-155 transaction. The digest is signed as-is (`prehash: false`) — the
 * caller hashes with keccak256, which is what Ethereum signs; the curve's default SHA-256 prehash
 * would produce a signature no node accepts.
 *
 * The recovery id is found rather than assumed: noble's `sign` returns the compact `r||s` without
 * it, so the signer recovers both candidate public keys and keeps the one matching the signer's.
 * That is one extra point multiplication per signature and it makes the `v` in EIP-155 exact.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';

import { nobleKeccak } from './keccak_noble.js';

/** A 32-byte private key, as `0x`-prefixed hex. */
export type PrivateKeyHex = string;

/** A signed digest: the compact `r||s` and the recovery id that reconstructs the signer. */
export interface SignatureParts {
  readonly r: bigint;
  readonly s: bigint;
  readonly recovery: 0 | 1;
}

/** The Ethereum address for `privateKey`, checksummed from the keccak of the public key. */
export function privateKeyToAddress(privateKey: PrivateKeyHex): string {
  const pub = secp256k1.getPublicKey(privateKeyBytes(privateKey), false);
  const digest = keccak256(pub.subarray(1));
  return `0x${toHex(digest.subarray(digest.length - 20))}`;
}

/** Sign `digest` (already keccak256-hashed) with `privateKey`, returning r, s and the recovery id. */
export function signDigest(digest: Uint8Array, privateKey: PrivateKeyHex): SignatureParts {
  if (digest.length !== 32) {
    throw new Error(`a digest is 32 bytes, got ${String(digest.length)}`);
  }
  const signature = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, privateKeyBytes(privateKey), { prehash: false }),
  );
  const signerPublic = secp256k1.getPublicKey(privateKeyBytes(privateKey), false);
  for (const recovery of [0, 1] as const) {
    const candidate = signature.addRecoveryBit(recovery).recoverPublicKey(digest).toBytes(false);
    if (candidate.every((byte, index) => byte === signerPublic[index])) {
      return { r: signature.r, s: signature.s, recovery };
    }
  }
  throw new Error('signature recovery failed: neither candidate matches the signer');
}

function privateKeyBytes(privateKey: PrivateKeyHex): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('private key must be 0x followed by 64 hex characters');
  }
  return hexToBytes(privateKey);
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function keccak256(bytes: Uint8Array): Uint8Array {
  return nobleKeccak(bytes);
}
