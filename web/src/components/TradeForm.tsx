'use client';

import { type FormEvent, type ReactNode, useState } from 'react';

import { buildBuyLong, buildBuyShort } from '../domain/trade.js';
import { describeCaughtError, parseDigitAmount } from './parseAmount.js';

export function TradeForm(): ReactNode {
  const [side, setSide] = useState<'long' | 'short'>('long');
  const [collateralIn, setCollateralIn] = useState('');
  const [minOut, setMinOut] = useState('');
  const [steps, setSteps] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function onPreview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setSteps([]);
    try {
      const collateral = parseDigitAmount(collateralIn);
      const min = parseDigitAmount(minOut);
      const batch =
        side === 'long'
          ? buildBuyLong({ collateralIn: collateral, minLongOut: min })
          : buildBuyShort({ collateralIn: collateral, minShortOut: min });
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
    </section>
  );
}
