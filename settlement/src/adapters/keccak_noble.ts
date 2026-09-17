/**
 * The keccak-256 primitive, as `@noble/hashes` implements the original Keccak.
 *
 * Domain owns the preimage layout; this adapter owns the hash. Node's `crypto.createHash('sha3-256')`
 * is NIST SHA3 and agrees with Ethereum keccak256 on nothing — see calibrator `domain/ports.ts`.
 */

import { type Keccak } from '@bell/calibrator/domain/ports.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Keccak-256 as the settlement CLI and fixture-backed verify path use it. */
export const nobleKeccak: Keccak = (data: Uint8Array): Uint8Array => keccak_256(data);
