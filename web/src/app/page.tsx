import Link from 'next/link';
import type { ReactNode } from 'react';

import { resolveSources } from '../adapters/corpus.js';
import { loadCatalogue } from '../application/catalogue.js';

export default async function HomePage(): Promise<ReactNode> {
  const { logSource, indexerConfig } = resolveSources();
  const catalogue = await loadCatalogue(logSource, indexerConfig);

  return (
    <div>
      <h2>Sessions</h2>
      {catalogue.sessions.length === 0 ? (
        <p>No sessions in the catalogue.</p>
      ) : (
        <ul>
          {catalogue.sessions.map((session) => (
            <li key={session.address}>
              <Link href={`/sessions/${session.address}`}>{session.address}</Link>
              {' — '}λ {session.lam}, expiry {session.expiryTimestamp}, registered{' '}
              {String(session.registered)}, settled {String(session.settled)}
            </li>
          ))}
        </ul>
      )}
      <h2>Challenge</h2>
      <p>
        <Link href="/challenge">Challenge</Link>
        {' — '}
        pre-bond verification of fixture cases
      </p>
    </div>
  );
}
