'use client';

import { nobleKeccak } from '@bell/settlement/adapters/keccak_noble.js';
import { type ReactNode, useState } from 'react';

import { injectedWallet } from '../adapters/wallet.js';
import { broadcastIntents, type BroadcastTargets } from '../application/broadcast.js';
import { type IntentBatch } from '../domain/intents.js';

export interface BroadcastButtonProps {
  /** Builds the batch from the form's current state. Throws refuse the broadcast by name. */
  readonly build: () => IntentBatch;
  /** The addresses the batch's targets resolve against; only the referenced ones are used. */
  readonly targets: BroadcastTargets;
}

/**
 * The write side of an intent form: connect the injected wallet, broadcast the batch the form
 * built, and show one hash per step. The wallet is injected at click time — the app never holds
 * keys, and a missing wallet is a refusal rather than a silent no-op.
 */
export function BroadcastButton({ build, targets }: BroadcastButtonProps): ReactNode {
  const [hashes, setHashes] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function onBroadcast(): void {
    void (async (): Promise<void> => {
      setError(null);
      setHashes([]);
      try {
        const batch = build();
        const wallet = injectedWallet((globalThis as { ethereum?: unknown }).ethereum);
        const outcome = await broadcastIntents(batch, targets, wallet, nobleKeccak);
        setHashes(outcome.hashes);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }

  return (
    <div>
      <button type="button" onClick={onBroadcast} data-testid="broadcast">
        Broadcast
      </button>
      {error !== null ? <p data-testid="broadcast-error">{error}</p> : null}
      {hashes.length > 0 ? (
        <ol data-testid="broadcast-hashes">
          {hashes.map((hash) => (
            <li key={hash}>{hash}</li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
