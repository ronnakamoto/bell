'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { buildWithdrawPool } from '../domain/settlement.js';
import { BroadcastButton } from './BroadcastButton.js';

export interface WithdrawPoolFormProps {
  /** The session the withdraw batch acts on. */
  readonly sessionAddress: string;
}

export function WithdrawPoolForm({ sessionAddress }: WithdrawPoolFormProps): ReactNode {
  const [steps, setSteps] = useState<readonly string[]>([]);

  function onPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const batch = buildWithdrawPool();
    setSteps(batch.steps.map((step) => step.label));
  }

  return (
    <section aria-label="Withdraw pool">
      <h3>Withdraw pool</h3>
      <form onSubmit={onPreview}>
        <button type="submit" data-testid="withdraw-pool-preview">
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
      <BroadcastButton build={buildWithdrawPool} targets={{ session: sessionAddress }} />
    </section>
  );
}
