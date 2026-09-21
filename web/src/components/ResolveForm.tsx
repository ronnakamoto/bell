'use client';

import { decodeAddressWord, fragmentOf, selectorOf } from '@bell/calibrator/domain/abi.js';
import { nobleKeccak } from '@bell/settlement/adapters/keccak_noble.js';
import { type ReactNode, useState } from 'react';

import { injectedWallet } from '../adapters/wallet.js';
import { broadcastIntents } from '../application/broadcast.js';
import { buildResolve } from '../domain/challenge_intent.js';

export interface ResolveFormProps {
  readonly nameId: string;
  /** Decimal string: client components cannot take `bigint` from the server. */
  readonly forSession: string;
  /** Whether the committed parameter matches its committed inputs, from the report. */
  readonly publisherCorrect: boolean;
  /** The premium registry, whose `arbiter()` is the only account that may rule. */
  readonly premiumAddress: string;
}

/**
 * The arbiter's ruling surface. The ruling is deterministic — the re-fit either matches the
 * committed inputs or it does not — so submitting it is one `resolve` step. The form reads the
 * registry's `arbiter()` and refuses a connected account that is not the arbiter by name; the
 * chain enforces the same gate, so the read is a named refusal rather than an opaque revert.
 */
export function ResolveForm({
  nameId,
  forSession,
  publisherCorrect,
  premiumAddress,
}: ResolveFormProps): ReactNode {
  const [hashes, setHashes] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(): void {
    void (async (): Promise<void> => {
      setError(null);
      setHashes([]);
      try {
        const wallet = injectedWallet((globalThis as { ethereum?: unknown }).ethereum);
        const account = await wallet.connect();
        const arbiter = decodeAddressWord(
          await wallet.read(premiumAddress, selectorOf(fragmentOf('arbiter'), nobleKeccak)),
        );
        if (account.toLowerCase() !== arbiter.toLowerCase()) {
          throw new Error(`only the arbiter (${arbiter}) can rule; connected as ${account}`);
        }
        const batch = buildResolve({ nameId, forSession: BigInt(forSession), publisherCorrect });
        const outcome = await broadcastIntents(
          batch,
          { premium: premiumAddress },
          wallet,
          nobleKeccak,
        );
        setHashes(outcome.hashes);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }

  return (
    <section aria-label="Ruling">
      <h3>Ruling</h3>
      <p>
        The re-fit is deterministic; the arbiter submits the ruling. The chain enforces that only
        the arbiter can.
      </p>
      <button type="button" onClick={onSubmit} data-testid="resolve-submit">
        Submit ruling
      </button>
      {error !== null ? <p data-testid="resolve-error">{error}</p> : null}
      {hashes.length > 0 ? (
        <ol data-testid="resolve-hashes">
          {hashes.map((hash) => (
            <li key={hash}>{hash}</li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
