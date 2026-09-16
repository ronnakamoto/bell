import type { ReactNode } from 'react';

import { formatQuote, type Quote } from '../domain/quote.js';

export interface QuotePanelProps {
  readonly quote: Quote;
}

/** Render an honest quote verdict — Refuse never shows a numeric premium. */
export function QuotePanel({ quote }: QuotePanelProps): ReactNode {
  const display = formatQuote(quote);

  if (display.kind === 'refuse') {
    return (
      <section aria-label="Quote">
        <h3>Quote</h3>
        <p data-testid="quote-refuse">{display.message}</p>
      </section>
    );
  }

  return (
    <section aria-label="Quote">
      <h3>Quote</h3>
      <p>Verdict: {display.verdict}</p>
      {display.isFallback ? <p>Source: fallback</p> : null}
      <p>λ: {display.lambda}</p>
      <p data-testid="quote-premium">Premium: {display.premium}</p>
    </section>
  );
}
