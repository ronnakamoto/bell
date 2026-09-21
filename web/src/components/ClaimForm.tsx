'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { buildClaim } from '../domain/settlement.js';
import { BroadcastButton } from './BroadcastButton.js';

export interface ClaimFormProps {
  /** The session the claim batch acts on. */
  readonly sessionAddress: string;
}

export function ClaimForm({ sessionAddress }: ClaimFormProps): ReactNode {
  const [steps, setSteps] = useState<readonly string[]>([]);

  function onPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const batch = buildClaim();
    setSteps(batch.steps.map((step) => step.label));
  }

  return (
    <section aria-label="Claim">
      <h3>Claim</h3>
      <form onSubmit={onPreview}>
        <button type="submit" data-testid="claim-preview">
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
      <BroadcastButton build={buildClaim} targets={{ session: sessionAddress }} />
    </section>
  );
}
