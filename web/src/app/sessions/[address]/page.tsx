import { FileLogSource } from '@bell/indexer/adapters/log_source_file.js';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { INDEXER_CONFIG, LOGS_PATH, QUOTES_PATH } from '../../../adapters/corpus.js';
import { FileQuoteSource } from '../../../adapters/quote_source_file.js';
import { loadSession } from '../../../application/catalogue.js';
import { loadQuote } from '../../../application/quote.js';
import { QuotePanel } from '../../../components/QuotePanel.js';
import { type Quote } from '../../../domain/quote.js';

const logSource = new FileLogSource(LOGS_PATH);
const quoteSource = new FileQuoteSource(QUOTES_PATH);

export default async function SessionPage({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<ReactNode> {
  const { address } = await params;
  const session = await loadSession(logSource, INDEXER_CONFIG, address);
  if (session === undefined) notFound();

  const linkedName = session.names[0];
  let quote: Quote;
  if (linkedName === undefined) {
    quote = { verdict: 'Refuse' };
  } else {
    quote = await loadQuote(quoteSource, linkedName.nameId, BigInt(linkedName.forSession));
  }

  return (
    <div>
      <p>
        <Link href="/">← Sessions</Link>
      </p>
      <h2>{session.address}</h2>
      <dl>
        <dt>λ</dt>
        <dd>{session.lam}</dd>
        <dt>Expiry</dt>
        <dd>{session.expiryTimestamp}</dd>
        <dt>Registered</dt>
        <dd>{String(session.registered)}</dd>
        <dt>Settled</dt>
        <dd>{String(session.settled)}</dd>
        <dt>Reference token</dt>
        <dd>{session.referenceToken}</dd>
        <dt>Notional cap</dt>
        <dd>{session.notionalCap}</dd>
        <dt>Cap</dt>
        <dd>{session.cap}</dd>
        <dt>Salt</dt>
        <dd>{session.salt}</dd>
      </dl>
      {session.names.length > 0 ? (
        <section aria-label="Linked names">
          <h3>Linked names</h3>
          <ul>
            {session.names.map((name) => (
              <li key={name.nameId}>
                {name.nameId} — forSession {name.forSession}, λ {name.lambda}, premium{' '}
                {name.premium}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <QuotePanel quote={quote} />
    </div>
  );
}
