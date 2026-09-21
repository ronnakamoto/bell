/**
 * The publish CLI's broadcast half.
 *
 * `publish.ts` calibrates, publishes, writes the window and prints the commit intent; this module
 * takes over when the operator also passes `--rpc-url`, `--private-key` and `--premium` — it
 * validates the flag set, derives the publisher from the key, and sends the two-step batch through
 * the RPC node. Kept out of `publish.ts` so the composition root stays under the 400-line layout
 * limit while the broadcast stays one module with one job.
 */

import { nobleKeccak } from '../adapters/keccak_noble.js';
import { JsonRpcClient } from '../adapters/rpc_client.js';
import { rpcBroadcastNode } from '../adapters/rpc_broadcast_node.js';
import { privateKeyToAddress } from '../adapters/signer.js';
import { signLegacyTx } from '../adapters/tx_signer.js';
import { broadcastCommitBatch } from '../application/broadcast.js';
import { type CommitIntentBatch } from '../domain/commit_intent.js';

/** The broadcast flags, validated as a set. */
export interface BroadcastFlags {
  readonly rpcUrl: string;
  readonly privateKey: string;
  readonly premium: string;
}

/** Thrown when the broadcast flags are not a complete, well-formed set. */
export class BroadcastUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BroadcastUsageError';
  }
}

/** The broadcast flags must come as a set: a node, a key, and the premium registry. */
export function requireBroadcastFlags(parsed: {
  readonly rpcUrl: string | undefined;
  readonly privateKey: string | undefined;
  readonly premium: string | undefined;
}): BroadcastFlags {
  const { rpcUrl, privateKey, premium } = parsed;
  if (rpcUrl === undefined && privateKey === undefined && premium === undefined) {
    throw new BroadcastUsageError(
      'no broadcast: pass --rpc-url, --private-key and --premium together',
    );
  }
  if (rpcUrl === undefined || privateKey === undefined || premium === undefined) {
    throw new BroadcastUsageError(
      'broadcast needs --rpc-url, --private-key and --premium together',
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(premium)) {
    throw new BroadcastUsageError('--premium must be a 0x-prefixed address');
  }
  return { rpcUrl, privateKey, premium };
}

/** Broadcast the intent: resolve the collateral, then send approve + commit. */
export async function broadcastIntent(
  intent: CommitIntentBatch,
  flags: BroadcastFlags,
  write: (line: string) => unknown,
): Promise<void> {
  const { rpcUrl, privateKey, premium } = flags;
  const publisher = privateKeyToAddress(privateKey);
  const node = rpcBroadcastNode(new JsonRpcClient({ url: rpcUrl }));
  const hashes = await broadcastCommitBatch({
    batch: intent,
    premium,
    publisher,
    node,
    signer: (tx) => signLegacyTx(tx, privateKey),
    keccak: nobleKeccak,
  });
  write(hashes.map((hash, index) => `tx${String(index + 1)}=${hash}`).join('\n') + '\n');
}
