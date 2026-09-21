/**
 * RLP and the EIP-155 tx builder.
 *
 * The canonical EIP-155 test vector pins the whole pipeline: a known key, nonce, gas price and
 * value must produce the exact raw transaction from the specification. The RLP unit tests cover
 * the two length rules (short string, long string) and the list form.
 */

import { describe, expect, it } from 'vitest';

import { bigEndian, rlpEncode } from '../../src/adapters/rlp.js';
import { signLegacyTx } from '../../src/adapters/tx_signer.js';

const TEST_KEY = '0x4646464646464646464646464646464646464646464646464646464646464646';

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('rlpEncode', () => {
  it('encodes a single byte below 0x80 as itself', () => {
    expect(hexOf(rlpEncode(Uint8Array.of(0x7f)))).toBe('7f');
  });

  it('encodes a single byte at or above 0x80 with a length prefix', () => {
    expect(hexOf(rlpEncode(Uint8Array.of(0x80)))).toBe('8180');
  });

  it('encodes a short string with a 0x80-prefixed length', () => {
    expect(hexOf(rlpEncode(new TextEncoder().encode('dog')))).toBe('83646f67');
  });

  it('encodes a list of strings with a 0xc0-prefixed length', () => {
    const cat = new TextEncoder().encode('cat');
    const dog = new TextEncoder().encode('dog');
    expect(hexOf(rlpEncode([cat, dog]))).toBe('c88363617483646f67');
  });

  it('encodes a long string (56+ bytes) with a length-of-length prefix', () => {
    const long = new Uint8Array(56).fill(0x61);
    expect(hexOf(rlpEncode(long))).toBe('b838' + '61'.repeat(56));
  });
});

describe('bigEndian', () => {
  it('encodes zero as the empty byte string, per RLP', () => {
    expect(hexOf(bigEndian(0n))).toBe('');
  });

  it('encodes a value with no leading zeros', () => {
    expect(hexOf(bigEndian(256n))).toBe('0100');
  });
});

describe('signLegacyTx', () => {
  it('reproduces the canonical EIP-155 test vector', () => {
    const raw = signLegacyTx(
      {
        nonce: 9n,
        gasPrice: 20_000_000_000n,
        gasLimit: 21_000n,
        to: '0x3535353535353535353535353535353535353535',
        value: 1_000_000_000_000_000_000n,
        data: '0x',
        chainId: 1n,
      },
      TEST_KEY,
    );
    expect(raw).toBe(
      '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83',
    );
  });

  it('refuses non-hex calldata', () => {
    expect(() =>
      signLegacyTx(
        {
          nonce: 0n,
          gasPrice: 1n,
          gasLimit: 21_000n,
          to: '0x3535353535353535353535353535353535353535',
          value: 0n,
          data: 'not-hex',
          chainId: 1n,
        },
        TEST_KEY,
      ),
    ).toThrow(/0x-prefixed hex/);
  });
});
