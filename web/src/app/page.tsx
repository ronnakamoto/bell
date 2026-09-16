import { FileLogSource } from '@bell/indexer/adapters/log_source_file.js';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { INDEXER_CONFIG, LOGS_PATH } from '../adapters/corpus.js';
import { loadCatalogue } from '../application/catalogue.js';

const logSource = new FileLogSource(LOGS_PATH);

export default async function HomePage(): Promise<ReactNode> {
  const catalogue = await loadCatalogue(logSource, INDEXER_CONFIG);

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
              {' — '}
              λ {session.lam}, registered {String(session.registered)}, settled{' '}
              {String(session.settled)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
