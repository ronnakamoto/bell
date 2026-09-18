import type { ReactNode } from 'react';

import { type ChallengeReportView } from '../domain/challenge.js';

export interface ChallengeReportProps {
  readonly report: ChallengeReportView;
}

/** Render an adjudication report — every kind is distinct and the kind token is visible. */
export function ChallengeReport({ report }: ChallengeReportProps): ReactNode {
  switch (report.kind) {
    case 'upheld':
      return (
        <section aria-label="Challenge report">
          <h3>Challenge report</h3>
          <p data-testid="challenge-kind">kind={report.kind}</p>
          <p data-testid="challenge-premium-delta">Premium Δ: {report.premiumDeltaWad}</p>
          <p data-testid="challenge-digest">Digest: {report.digest}</p>
        </section>
      );
    case 'slashed':
      return (
        <section aria-label="Challenge report">
          <h3>Challenge report</h3>
          <p data-testid="challenge-kind">kind={report.kind}</p>
          <p data-testid="challenge-reason">Reason: {report.reason}</p>
          <p data-testid="challenge-digest">Digest: {report.digest}</p>
        </section>
      );
    case 'inputs-unavailable':
      return (
        <section aria-label="Challenge report">
          <h3>Challenge report</h3>
          <p data-testid="challenge-kind">kind={report.kind}</p>
          <p data-testid="challenge-reason">Reason: {report.reason}</p>
        </section>
      );
    case 'digest-mismatch':
      return (
        <section aria-label="Challenge report">
          <h3>Challenge report</h3>
          <p data-testid="challenge-kind">kind={report.kind}</p>
          <p data-testid="challenge-expected">Expected: {report.expected}</p>
          <p data-testid="challenge-computed">Computed: {report.computed}</p>
        </section>
      );
  }
}
