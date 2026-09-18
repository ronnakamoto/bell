import Link from 'next/link';
import type { ReactNode } from 'react';

import { FileChallengeSource } from '../../adapters/challenge_verify.js';
import { listChallengeLabels } from '../../application/challenge.js';

export default async function ChallengeListPage(): Promise<ReactNode> {
  const labels = await listChallengeLabels(new FileChallengeSource());

  return (
    <div>
      <p>
        <Link href="/">← Sessions</Link>
      </p>
      <h2>Challenge</h2>
      <p>
        Pre-bond verification of fixture cases. Same store re-fit as the CLI. Challenge intent
        preview is available when a report is slashed; no wallet, no broadcast.
      </p>
      {labels.length === 0 ? (
        <p>No challenge cases.</p>
      ) : (
        <ul>
          {labels.map((label) => (
            <li key={label}>
              <Link href={`/challenge/${label}`}>{label}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
