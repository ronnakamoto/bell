/**
 * Builds and signs an EIP-155 legacy transaction.
 *
 * A legacy tx is RLP `[nonce, gasPrice, gasLimit, to, value, data]`; EIP-155 signs
 * `[nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]` and encodes the recovery id into
 * `v = chainId * 2 + 35 + recovery`. The raw signed transaction is what `eth_sendRawTransaction`
 * accepts. The signer derives the recovery id by matching the recovered public key, so `v` is
 * exact rather than guessed.
 */

import { nobleKeccak } from './keccak_noble.js';
import { bigEndian, rlpEncode } from './rlp.js';
import { type PrivateKeyHex, signDigest } from './signer.js';

/** One unsigned legacy transaction. */
export interface UnsignedTx {
  readonly nonce: bigint;
  readonly gasPrice: bigint;
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  /** The calldata, as `0x`-prefixed hex. */
  readonly data: string;
  readonly chainId: bigint;
}

/** Sign `tx` with `privateKey`, returning the raw transaction for `eth_sendRawTransaction`. */
export function signLegacyTx(tx: UnsignedTx, privateKey: PrivateKeyHex): string {
  const fields = txFields(tx);
  const signingPayload = rlpEncode([
    ...fields,
    bigEndian(tx.chainId),
    bigEndian(0n),
    bigEndian(0n),
  ]);
  const digest = nobleKeccak(signingPayload);
  const { r, s, recovery } = signDigest(digest, privateKey);
  const v = tx.chainId * 2n + 35n + BigInt(recovery);
  const signed = rlpEncode([...fields, bigEndian(v), bigEndian(r), bigEndian(s)]);
  return `0x${toHex(signed)}`;
}

/** The six RLP fields of a legacy tx, in order. */
function txFields(tx: UnsignedTx): readonly Uint8Array[] {
  return [
    bigEndian(tx.nonce),
    bigEndian(tx.gasPrice),
    bigEndian(tx.gasLimit),
    hexToBytes(tx.to),
    bigEndian(tx.value),
    hexToBytes(tx.data),
  ];
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`expected 0x-prefixed hex, got ${hex}`);
  }
  const body = hex.slice(2);
  const padded = body.length % 2 === 1 ? `0${body}` : body;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
