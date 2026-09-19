/**
 * The keccak-256 primitive, as `@noble/hashes` implements the original Keccak.
 *
 * Domain owns the preimage layout; this adapter owns the hash. Node's `crypto.createHash('sha3-256')`
 * is NIST SHA3 and agrees with Ethereum keccak256 on nothing — see `domain/ports.ts`.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';

import { type Keccak } from '../domain/ports.js';

/** Keccak-256 as the calibrator CLI composition root uses it. */
export const nobleKeccak: Keccak = (data: Uint8Array): Uint8Array => keccak_256(data);
