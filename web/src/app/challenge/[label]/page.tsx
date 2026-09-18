import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { FileChallengeSource } from '../../../adapters/challenge_verify.js';
import { listChallengeLabels, verifyChallengeCase } from '../../../application/challenge.js';
import { ChallengeReport } from '../../../components/ChallengeReport.js';

export default async function ChallengeCasePage({
  params,
}: {
  params: Promise<{ label: string }>;
}): Promise<ReactNode> {
  const { label } = await params;
  const source = new FileChallengeSource();
  const labels = await listChallengeLabels(source);
  if (!labels.includes(label)) notFound();

  const report = await verifyChallengeCase(source, label);

  return (
    <div>
      <p>
        <Link href="/challenge">← Challenge</Link>
      </p>
      <h2>{label}</h2>
      <p>Pre-bond verification. Same store re-fit as the CLI; no bond, no on-chain challenge.</p>
      <ChallengeReport report={report} />
    </div>
  );
}
