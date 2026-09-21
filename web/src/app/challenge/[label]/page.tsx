import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { FileChallengeSource } from '../../../adapters/challenge_verify.js';
import { resolveSources } from '../../../adapters/corpus.js';
import {
  listChallengeLabels,
  loadChallengeIdentity,
  verifyChallengeCase,
} from '../../../application/challenge.js';
import { ChallengeForm } from '../../../components/ChallengeForm.js';
import { ChallengeReport } from '../../../components/ChallengeReport.js';
import { EligibilityGate } from '../../../components/EligibilityGate.js';
import { ResolveForm } from '../../../components/ResolveForm.js';
import { type ChallengeReportView } from '../../../domain/challenge.js';
import { type ChallengeSource } from '../../../domain/ports.js';

export default async function ChallengeCasePage({
  params,
}: {
  params: Promise<{ label: string }>;
}): Promise<ReactNode> {
  const { label } = await params;
  const { indexerConfig } = resolveSources();
  const source = new FileChallengeSource();
  const labels = await listChallengeLabels(source);
  if (!labels.includes(label)) notFound();

  const report = await verifyChallengeCase(source, label);
  const intent = await challengeIntent(source, label, report, indexerConfig.premium);
  const ruling = await arbiterRuling(source, label, report, indexerConfig.premium);

  return (
    <div>
      <p>
        <Link href="/challenge">← Challenge</Link>
      </p>
      <h2>{label}</h2>
      <p>
        Same store re-fit as the CLI. Challenge intent preview and broadcast are available when the
        report is slashed, and the arbiter's ruling surface when it is upheld or slashed; no wallet
        is held by the app.
      </p>
      <ChallengeReport report={report} />
      {intent}
      {ruling}
    </div>
  );
}

/** The arbiter's ruling surface, shown when the report is a ruling the arbiter can submit. */
async function arbiterRuling(
  source: ChallengeSource,
  label: string,
  report: ChallengeReportView,
  premium: string,
): Promise<ReactNode> {
  if (report.kind !== 'upheld' && report.kind !== 'slashed') {
    return null;
  }

  const identity = await loadChallengeIdentity(source, label);
  return (
    <EligibilityGate>
      <ResolveForm
        nameId={identity.nameId}
        forSession={identity.forSession.toString()}
        publisherCorrect={report.kind === 'upheld'}
        premiumAddress={premium}
      />
    </EligibilityGate>
  );
}

async function challengeIntent(
  source: ChallengeSource,
  label: string,
  report: ChallengeReportView,
  premium: string,
): Promise<ReactNode> {
  if (report.kind !== 'slashed') {
    return disabledChallengeIntent(report.kind);
  }

  const identity = await loadChallengeIdentity(source, label);
  return (
    <EligibilityGate>
      <ChallengeForm
        nameId={identity.nameId}
        forSession={identity.forSession.toString()}
        premiumAddress={premium}
      />
    </EligibilityGate>
  );
}

function disabledChallengeIntent(kind: Exclude<ChallengeReportView['kind'], 'slashed'>): ReactNode {
  switch (kind) {
    case 'upheld':
      return (
        <p data-testid="challenge-intent-disabled-upheld">
          Challenge intent is disabled because the report is upheld.
        </p>
      );
    case 'inputs-unavailable':
      return (
        <p data-testid="challenge-intent-disabled-inputs-unavailable">
          Challenge intent is disabled because committed inputs are unavailable.
        </p>
      );
    case 'digest-mismatch':
      return (
        <p data-testid="challenge-intent-disabled-digest-mismatch">
          Challenge intent is disabled because the commitment digest does not match.
        </p>
      );
  }
}
