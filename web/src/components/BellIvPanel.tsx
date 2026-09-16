import type { ReactNode } from 'react';

import { type IvDisplay } from '../domain/iv.js';

export interface BellIvPanelProps {
  readonly iv: IvDisplay;
}

/** Render published BELL-IV — omit never shows a numeric sigma. */
export function BellIvPanel({ iv }: BellIvPanelProps): ReactNode {
  if (iv.kind === 'omit') {
    return (
      <section aria-label="BELL-IV">
        <h3>BELL-IV</h3>
        <p data-testid="bell-iv-omit">{iv.message}</p>
      </section>
    );
  }

  return (
    <section aria-label="BELL-IV" data-testid="bell-iv-show">
      <h3>BELL-IV</h3>
      <p>σ: {iv.sigma}</p>
      <p>Provenance: {iv.provenance}</p>
      <p>Age: {iv.ageSessions}</p>
    </section>
  );
}
