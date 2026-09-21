/**
 * The ABI table and encoding.
 *
 * The fixture pins every selector against a known-good value, so a typo in a signature fails the
 * suite rather than silently producing calldata the chain rejects. The encoding tests cover the
 * padding rules and the named refusals.
 */

import { nobleKeccak } from '@bell/settlement/adapters/keccak_noble.js';
import { describe, expect, it } from 'vitest';

import {
  ABI_FRAGMENTS,
  decodeAddressWord,
  encodeCalldata,
  encodeWord,
  fragmentOf,
  selectorOf,
} from '../../src/domain/abi.js';

const SESSION = '0x1111111111111111111111111111111111111111';
const COLLATERAL = '0x2222222222222222222222222222222222222222';

describe('selectorOf', () => {
  it('pins every fragment selector against a known-good value', () => {
    const expected: Readonly<Record<string, string>> = {
      approve: '0x095ea7b3',
      buyLong: '0xcdff7616',
      buyShort: '0x00db2967',
      mintPair: '0xc0c3b517',
      seedPool: '0x3a6008c8',
      claim: '0x4e71d92d',
      withdrawPool: '0x5c42c733',
      challenge: '0x1cd3c0dd',
      collateral: '0xd8dfeb45',
      longClaim: '0x1671ce49',
      shortClaim: '0x223b052d',
      bondToken: '0xc28f4392',
    };
    for (const [method, selector] of Object.entries(expected)) {
      expect(selectorOf(fragmentOf(method), nobleKeccak)).toBe(selector);
    }
  });

  it('refuses a method with no fragment', () => {
    expect(() => fragmentOf('noSuchMethod')).toThrow(/no ABI fragment/);
  });
});

describe('encodeWord', () => {
  it('left-pads an address with twelve zero bytes', () => {
    expect(encodeWord('address', SESSION)).toBe(`0x${'00'.repeat(12)}${SESSION.slice(2)}`);
  });

  it('left-pads a uint256 to 32 bytes', () => {
    expect(encodeWord('uint256', 1n)).toBe(`0x${'00'.repeat(31)}01`);
  });

  it('left-pads a uint64 to 32 bytes', () => {
    expect(encodeWord('uint64', 1n)).toBe(`0x${'00'.repeat(31)}01`);
  });

  it('passes a bytes32 through unchanged', () => {
    const word = `0x${'ab'.repeat(32)}`;
    expect(encodeWord('bytes32', word)).toBe(word);
  });

  it('refuses an address that is not 20 bytes', () => {
    expect(() => encodeWord('address', '0x1234')).toThrow(/address must be 0x/);
  });

  it('refuses a uint that overflows its type', () => {
    expect(() => encodeWord('uint64', 1n << 64n)).toThrow(/uint64 must fit in 64 bits/);
    expect(() => encodeWord('uint256', -1n)).toThrow(/uint256 must fit in 256 bits/);
  });

  it('refuses a string where a bigint is required', () => {
    expect(() => encodeWord('uint256', '1')).toThrow(/uint256 must be a bigint/);
  });

  it('refuses a bytes32 that is not 64 hex characters', () => {
    expect(() => encodeWord('bytes32', '0x1234')).toThrow(/bytes32 must be 0x/);
  });
});

describe('encodeCalldata', () => {
  it('encodes approve as selector plus spender and amount', () => {
    const calldata = encodeCalldata(
      { label: 'x', target: 'collateral', method: 'approve', args: [COLLATERAL, 100n] },
      nobleKeccak,
    );
    expect(calldata).toBe(`0x095ea7b3${'00'.repeat(12)}${COLLATERAL.slice(2)}${'00'.repeat(31)}64`);
  });

  it('encodes a zero-argument method as its selector alone', () => {
    const calldata = encodeCalldata(
      { label: 'x', target: 'session', method: 'claim', args: [] },
      nobleKeccak,
    );
    expect(calldata).toBe('0x4e71d92d');
  });

  it('encodes challenge with a bytes32 nameId and uint64 forSession', () => {
    const nameId = `0x${'cd'.repeat(32)}`;
    const calldata = encodeCalldata(
      { label: 'x', target: 'premium', method: 'challenge', args: [nameId, 7n] },
      nobleKeccak,
    );
    expect(calldata).toBe(`0x1cd3c0dd${'cd'.repeat(32)}${'00'.repeat(31)}07`);
  });

  it('refuses an argument count that does not match the fragment', () => {
    expect(() =>
      encodeCalldata({ label: 'x', target: 'session', method: 'buyLong', args: [1n] }, nobleKeccak),
    ).toThrow(/buyLong takes 2 arguments, got 1/);
  });
});

describe('decodeAddressWord', () => {
  it('reads the address from the low 20 bytes of a word', () => {
    expect(decodeAddressWord(`0x${'00'.repeat(12)}${SESSION.slice(2)}`)).toBe(SESSION);
  });

  it('refuses a word with a non-zero prefix', () => {
    expect(() => decodeAddressWord(`0x${'01'.repeat(32)}`)).toThrow(/non-zero prefix/);
  });

  it('refuses a word that is not 32 bytes', () => {
    expect(() => decodeAddressWord('0x1234')).toThrow(/word must be 0x/);
  });
});

describe('ABI_FRAGMENTS', () => {
  it('covers every method the intent surface can name', () => {
    expect(Object.keys(ABI_FRAGMENTS).sort()).toEqual(
      [
        'approve',
        'bondToken',
        'buyLong',
        'buyShort',
        'challenge',
        'claim',
        'collateral',
        'longClaim',
        'mintPair',
        'seedPool',
        'shortClaim',
        'withdrawPool',
      ].sort(),
    );
  });
});
