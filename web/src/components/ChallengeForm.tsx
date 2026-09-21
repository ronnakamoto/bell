'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { buildChallenge } from '../domain/challenge_intent.js';
import { type IntentBatch } from '../domain/intents.js';
import { BroadcastButton } from './BroadcastButton.js';

export interface ChallengeFormProps {
  readonly nameId: string;
  /** Decimal string: client components cannot take `bigint` from the server. */
  readonly forSession: string;
  /** The premium registry, whose `bondToken()` is the challenge bond's collateral. */
  readonly premiumAddress: string;
}

export function ChallengeForm({
  nameId,
  forSession,
  premiumAddress,
}: ChallengeFormProps): ReactNode {
  const [steps, setSteps] = useState<readonly string[]>([]);

  function buildBatch(): IntentBatch {
    return buildChallenge({ nameId, forSession: BigInt(forSession) });
  }

  function onPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const batch = buildBatch();
    setSteps(batch.steps.map((step) => step.label));
  }

  return (
    <section aria-label="Challenge">
      <h3>Challenge</h3>
      <form onSubmit={onPreview}>
        <button type="submit" data-testid="challenge-preview">
          Preview
        </button>
      </form>
      {steps.length > 0 ? (
        <ol>
          {steps.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ol>
      ) : null}
      <BroadcastButton build={buildBatch} targets={{ premium: premiumAddress }} />
    </section>
  );
}
