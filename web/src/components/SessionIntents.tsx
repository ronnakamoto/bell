import type { ReactNode } from 'react';

import { type Quote } from '../domain/quote.js';
import { LpForm } from './LpForm.js';
import { TradeForm } from './TradeForm.js';

export interface SessionIntentsProps {
  readonly quote: Quote;
}

/** Gate trade/LP intent forms on a non-Refuse quote. */
export function SessionIntents({ quote }: SessionIntentsProps): ReactNode {
  if (quote.verdict === 'Refuse') {
    return (
      <p data-testid="trade-disabled-refuse">
        Trade and LP intents are disabled because the quote was refused.
      </p>
    );
  }

  return (
    <>
      <TradeForm />
      <LpForm />
    </>
  );
}
