'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { buildWithdrawPool } from '../domain/settlement.js';

export function WithdrawPoolForm(): ReactNode {
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
    </section>
  );
}
