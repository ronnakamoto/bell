/**
 * The CLI broadcast use case: send the publisher's commit batch.
 *
 * The web broadcasts through an injected wallet; the CLI broadcasts through a node and a signer —
 * the publisher is an operator with a private key, so the batch's two steps (collateral approve,
 * then `PremiumRegistry.commit`) are signed locally and pushed with `eth_sendRawTransaction`.
 *
 * The design mirrors the web's `broadcastIntents`: targets are resolved by read, not guessed — the
 * premium registry is given, the collateral is read from its `bondToken()` getter — and the steps
 * are sent in intent order, one hash each, with the nonce advancing. An `approve` step names only
 * the amount; the spender is the contract the batch acts on, which for a commit is the premium
 * registry. A step that reverts on chain stops the batch where it is.
 */

import { decodeAddressWord, encodeCalldata, fragmentOf, selectorOf } from '../domain/abi.js';
import { type CommitIntentBatch } from '../domain/commit_intent.js';
import { type Keccak } from '../domain/ports.js';

/** The node calls a broadcast needs, one method each. */
export interface BroadcastNode {
  readonly chainId: () => Promise<bigint>;
  /** The account's pending nonce — the next one the node will accept. */
  readonly nonce: (account: string) => Promise<bigint>;
  readonly gasPrice: () => Promise<bigint>;
  readonly estimateGas: (from: string, to: string, data: string) => Promise<bigint>;
  readonly call: (to: string, data: string) => Promise<string>;
  readonly sendRawTransaction: (raw: string) => Promise<string>;
}

/** Signs an unsigned tx and returns the raw transaction. The CLI wires the private key here. */
export type BroadcastSigner = (tx: {
  readonly nonce: bigint;
  readonly gasPrice: bigint;
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly chainId: bigint;
}) => string;

/** Broadcast every step of the commit batch, returning one hash per step in step order. */
export async function broadcastCommitBatch(input: {
  readonly batch: CommitIntentBatch;
  /** The premium registry, given by the operator; everything else is read. */
  readonly premium: string;
  /** The publisher's account, derived from the private key by the caller. */
  readonly publisher: string;
  readonly node: BroadcastNode;
  readonly signer: BroadcastSigner;
  readonly keccak: Keccak;
}): Promise<readonly string[]> {
  const { batch, premium, publisher, node, signer, keccak } = input;
  const chainId = await node.chainId();
  const collateral = await readAddress(node, premium, 'bondToken', keccak);
  let nonce = await node.nonce(publisher);

  const hashes: string[] = [];
  for (const step of batch.steps) {
    const to = step.target === 'premium' ? premium : collateral;
    // The commit batch acts on the premium registry, so that is the approve spender.
    const args = step.method === 'approve' ? [premium, ...step.args] : step.args;
    const data = encodeCalldata(step.method, args, keccak);
    const gasPrice = await node.gasPrice();
    const gasLimit = await node.estimateGas(publisher, to, data);
    const raw = signer({
      nonce,
      gasPrice,
      gasLimit,
      to,
      value: 0n,
      data,
      chainId,
    });
    hashes.push(await node.sendRawTransaction(raw));
    nonce += 1n;
  }
  return hashes;
}

/** Read one zero-argument `address` getter and decode its result word. */
async function readAddress(
  node: BroadcastNode,
  at: string,
  method: string,
  keccak: Keccak,
): Promise<string> {
  const word = await node.call(at, selectorOf(fragmentOf(method), keccak));
  return decodeAddressWord(word);
}
