/**
 * The ABI fragments the broadcast layer encodes, and the encoding itself.
 *
 * Every method an intent step can name, plus the four read getters the broadcast use case needs to
 * resolve its targets (`collateral()`, `longClaim()`, `shortClaim()` on the session, `bondToken()`
 * on the premium registry). All inputs are static types — address, uint256, uint64, bytes32 — so
 * the encoding is selector plus one 32-byte word per argument, with no dynamic section. That is the
 * whole of the ABI surface the participant surface touches, and it is kept here so the encoding is
 * one table plus one function rather than a dependency on an ABI library.
 *
 * **The selector is computed, not copied.** A hardcoded `0x095ea7b3` next to
 * `approve(address,uint256)` is a typo that no test would catch; computing it from the signature
 * makes the table the only place a signature can be wrong, and the fixture test pins the result.
 * Keccak is a port (`@bell/calibrator/domain/ports.js`), injected like everywhere else in the
 * tree — this module is hermetic and the adapter supplies `@noble/hashes`.
 */

import { type Keccak } from '@bell/calibrator/domain/ports.js';

import { WebDomainError } from './errors.js';
import { type IntentStep } from './intents.js';

/** One ABI input type. Every type the intent surface uses is static. */
export type AbiType = 'address' | 'uint256' | 'uint64' | 'bytes32' | 'bool';

export interface AbiFragment {
  /** The canonical signature, as Solidity declares it. */
  readonly signature: string;
  /** The input types, in parameter order. */
  readonly inputs: readonly AbiType[];
}

/** A fragment per method name. Method names are unique across every intent kind. */
export const ABI_FRAGMENTS: Readonly<Record<string, AbiFragment>> = {
  approve: { signature: 'approve(address,uint256)', inputs: ['address', 'uint256'] },
  buyLong: { signature: 'buyLong(uint256,uint256)', inputs: ['uint256', 'uint256'] },
  buyShort: { signature: 'buyShort(uint256,uint256)', inputs: ['uint256', 'uint256'] },
  mintPair: { signature: 'mintPair(uint256)', inputs: ['uint256'] },
  seedPool: { signature: 'seedPool(uint256,uint256)', inputs: ['uint256', 'uint256'] },
  claim: { signature: 'claim()', inputs: [] },
  withdrawPool: { signature: 'withdrawPool()', inputs: [] },
  challenge: { signature: 'challenge(bytes32,uint64)', inputs: ['bytes32', 'uint64'] },
  resolve: { signature: 'resolve(bytes32,uint64,bool)', inputs: ['bytes32', 'uint64', 'bool'] },
  // Read getters the broadcast use case resolves its targets with.
  collateral: { signature: 'collateral()', inputs: [] },
  longClaim: { signature: 'longClaim()', inputs: [] },
  shortClaim: { signature: 'shortClaim()', inputs: [] },
  bondToken: { signature: 'bondToken()', inputs: [] },
  arbiter: { signature: 'arbiter()', inputs: [] },
};

const WORD_HEX_DIGITS = 64;
const ADDRESS_HEX_DIGITS = 40;
const BYTES32_HEX_DIGITS = 64;
const ADDRESS_PADDING_HEX_DIGITS = WORD_HEX_DIGITS - ADDRESS_HEX_DIGITS;

const HEX_PREFIX = /^0x[0-9a-fA-F]+$/;

/** The fragment for `method`, or a refusal naming the method. */
export function fragmentOf(method: string): AbiFragment {
  const fragment = ABI_FRAGMENTS[method];
  if (fragment === undefined) {
    throw new WebDomainError(`no ABI fragment for method ${method}`);
  }
  return fragment;
}

/** The four-byte selector of a fragment, from `keccak256(signature)`. */
export function selectorOf(fragment: AbiFragment, keccak: Keccak): string {
  const digest = keccak(new TextEncoder().encode(fragment.signature));
  return `0x${toHex(digest.subarray(0, 4))}`;
}

/** One argument as a 32-byte word, refusing a value that does not fit its type. */
export function encodeWord(type: AbiType, value: bigint | string): string {
  switch (type) {
    case 'address': {
      const address = requireHex(value, ADDRESS_HEX_DIGITS, 'address');
      return `0x${'0'.repeat(ADDRESS_PADDING_HEX_DIGITS)}${address.slice(2)}`;
    }
    case 'uint256': {
      const word = requireUint(value, 256, 'uint256').toString(16);
      return `0x${word.padStart(WORD_HEX_DIGITS, '0')}`;
    }
    case 'uint64': {
      const word = requireUint(value, 64, 'uint64').toString(16);
      return `0x${word.padStart(WORD_HEX_DIGITS, '0')}`;
    }
    case 'bytes32': {
      return requireHex(value, BYTES32_HEX_DIGITS, 'bytes32');
    }
    case 'bool': {
      const word = requireBool(value);
      return `0x${'00'.repeat(31)}${word}`;
    }
  }
}

function requireBool(value: bigint | string): string {
  if (typeof value === 'string') {
    throw new WebDomainError('bool must be a bigint');
  }
  if (value === 0n) return '00';
  if (value === 1n) return '01';
  throw new WebDomainError('bool must be 0 or 1');
}

/** The calldata for one intent step: selector then one word per argument. */
export function encodeCalldata(step: IntentStep, keccak: Keccak): string {
  const fragment = fragmentOf(step.method);
  if (fragment.inputs.length !== step.args.length) {
    throw new WebDomainError(
      `${step.method} takes ${String(fragment.inputs.length)} arguments, got ${String(step.args.length)}`,
    );
  }
  const words = fragment.inputs.map((type, index) => encodeWord(type, argAt(step.args, index)));
  return `${selectorOf(fragment, keccak)}${words.map((word) => word.slice(2)).join('')}`;
}

/** The argument at `index`, or a refusal — the length check above makes this unreachable. */
function argAt(args: readonly (bigint | string)[], index: number): bigint | string {
  const value = args[index];
  // The length check in `encodeCalldata` proves every index here, so the guard is a depth
  // guard rather than a reachable refusal — the same shape the indexer's fold hints.
  /* v8 ignore next 2 */
  if (value === undefined) {
    throw new WebDomainError(`missing argument ${String(index)}`);
  }
  return value;
}

/**
 * The address in a 32-byte `eth_call` result word, or a refusal when the top twelve bytes are not
 * zero. The same check the indexer's `addressOf` applies: it is what distinguishes an address from
 * a `bytes32` in the same position.
 */
export function decodeAddressWord(word: string): string {
  const body = requireHex(word, WORD_HEX_DIGITS, 'word');
  const padding = body.slice(2, 2 + ADDRESS_PADDING_HEX_DIGITS);
  if (padding !== '0'.repeat(ADDRESS_PADDING_HEX_DIGITS)) {
    throw new WebDomainError(`not an ABI-encoded address: ${word} has a non-zero prefix`);
  }
  return `0x${body.slice(2 + ADDRESS_PADDING_HEX_DIGITS)}`;
}

function requireHex(value: bigint | string, digits: number, label: string): string {
  if (typeof value !== 'string' || !HEX_PREFIX.test(value) || value.length !== 2 + digits) {
    throw new WebDomainError(`${label} must be 0x followed by ${String(digits)} hex characters`);
  }
  return `0x${value.slice(2).toLowerCase()}`;
}

function requireUint(value: bigint | string, bits: number, label: string): bigint {
  if (typeof value === 'string') {
    throw new WebDomainError(`${label} must be a bigint`);
  }
  if (value < 0n || value >= 1n << BigInt(bits)) {
    throw new WebDomainError(`${label} must fit in ${String(bits)} bits`);
  }
  return value;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
