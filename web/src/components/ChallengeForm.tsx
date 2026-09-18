'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { buildChallenge } from '../domain/challenge_intent.js';

export interface ChallengeFormProps {
  readonly nameId: string;
  /** Decimal string: client components cannot take `bigint` from the server. */
  readonly forSession: string;
}

export function ChallengeForm({ nameId, forSession }: ChallengeFormProps): ReactNode {
  const [steps, setSteps] = useState<readonly string[]>([]);

  function onPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const batch = buildChallenge({ nameId, forSession: BigInt(forSession) });
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
    </section>
  );
}
