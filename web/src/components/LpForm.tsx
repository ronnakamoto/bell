'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { type IntentBatch } from '../domain/intents.js';
import { buildMintThenSeed } from '../domain/lp.js';
import { BroadcastButton } from './BroadcastButton.js';
import { describeCaughtError, parseDigitAmount } from './parseAmount.js';

export interface LpFormProps {
  /** The session the LP batch acts on. */
  readonly sessionAddress: string;
}

export function LpForm({ sessionAddress }: LpFormProps): ReactNode {
  const [mintAmount, setMintAmount] = useState('');
  const [longIn, setLongIn] = useState('');
  const [shortIn, setShortIn] = useState('');
  const [steps, setSteps] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function buildBatch(): IntentBatch {
    return buildMintThenSeed({
      mintAmount: parseDigitAmount(mintAmount),
      longIn: parseDigitAmount(longIn),
      shortIn: parseDigitAmount(shortIn),
    });
  }

  function onPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setSteps([]);
    try {
      const batch = buildBatch();
      setSteps(batch.steps.map((step) => step.label));
    } catch (caught) {
      setError(describeCaughtError(caught));
    }
  }

  return (
    <section aria-label="LP">
      <h3>LP</h3>
      <form onSubmit={onPreview}>
        <label>
          Mint amount
          <input
            value={mintAmount}
            onChange={(event) => {
              setMintAmount(event.target.value);
            }}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label>
          Long in
          <input
            value={longIn}
            onChange={(event) => {
              setLongIn(event.target.value);
            }}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label>
          Short in
          <input
            value={shortIn}
            onChange={(event) => {
              setShortIn(event.target.value);
            }}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <button type="submit" data-testid="lp-preview">
          Preview
        </button>
      </form>
      {error !== null ? <p>{error}</p> : null}
      {steps.length > 0 ? (
        <ol>
          {steps.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ol>
      ) : null}
      <BroadcastButton build={buildBatch} targets={{ session: sessionAddress }} />
    </section>
  );
}
