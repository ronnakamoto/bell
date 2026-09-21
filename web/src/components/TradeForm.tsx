'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { type IntentBatch } from '../domain/intents.js';
import { buildBuyLong, buildBuyShort } from '../domain/trade.js';
import { BroadcastButton } from './BroadcastButton.js';
import { describeCaughtError, parseDigitAmount } from './parseAmount.js';

export interface TradeFormProps {
  /** The session the trade batch acts on. */
  readonly sessionAddress: string;
}

export function TradeForm({ sessionAddress }: TradeFormProps): ReactNode {
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [collateralIn, setCollateralIn] = useState('');
  const [minOut, setMinOut] = useState('');
  const [steps, setSteps] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function buildBatch(): IntentBatch {
    const collateral = parseDigitAmount(collateralIn);
    const min = parseDigitAmount(minOut);
    return side === 'long'
      ? buildBuyLong({ collateralIn: collateral, minLongOut: min })
      : buildBuyShort({ collateralIn: collateral, minShortOut: min });
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
    <section aria-label="Trade">
      <h3>Trade</h3>
      <form onSubmit={onPreview}>
        <label>
          Side
          <select
            value={side}
            onChange={(event) => {
              setSide(event.target.value === 'short' ? 'short' : 'long');
            }}
          >
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <label>
          Collateral in
          <input
            value={collateralIn}
            onChange={(event) => {
              setCollateralIn(event.target.value);
            }}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <label>
          Min out
          <input
            data-testid="trade-min-out"
            value={minOut}
            onChange={(event) => {
              setMinOut(event.target.value);
            }}
            inputMode="numeric"
            autoComplete="off"
          />
        </label>
        <button type="submit" data-testid="trade-preview">
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
