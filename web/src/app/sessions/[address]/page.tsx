import { FileLogSource } from '@bell/indexer/adapters/log_source_file.js';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { INDEXER_CONFIG, LOGS_PATH, QUOTES_PATH } from '../../../adapters/corpus.js';
import { FileQuoteSource } from '../../../adapters/quote_source_file.js';
import { loadSession } from '../../../application/catalogue.js';
import { loadQuote } from '../../../application/quote.js';
import { QuotePanel } from '../../../components/QuotePanel.js';
import { SessionIntents } from '../../../components/SessionIntents.js';
import { SessionSettlementIntents } from '../../../components/SessionSettlementIntents.js';
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
      {session.pool !== undefined ? (
        <section aria-label="Pool">
          <h3>Pool</h3>
          <dl>
            <dt>Long in</dt>
            <dd>{session.pool.longIn}</dd>
            <dt>Short in</dt>
            <dd>{session.pool.shortIn}</dd>
            <dt>Long reserve</dt>
            <dd>{session.pool.longReserve}</dd>
            <dt>Short reserve</dt>
            <dd>{session.pool.shortReserve}</dd>
          </dl>
        </section>
      ) : null}
      {session.lastTrade !== undefined ? (
        <section aria-label="Last trade">
          <h3>Last trade</h3>
          <dl>
            <dt>Trader</dt>
            <dd>{session.lastTrade.trader}</dd>
            <dt>Bought long</dt>
            <dd>{String(session.lastTrade.boughtLong)}</dd>
            <dt>Collateral in</dt>
            <dd>{session.lastTrade.collateralIn}</dd>
            <dt>Claim out</dt>
            <dd>{session.lastTrade.claimOut}</dd>
          </dl>
        </section>
      ) : null}
      {session.settlement !== undefined ? (
        <section aria-label="Settlement">
          <h3>Settlement</h3>
          <dl>
            <dt>Payoff long</dt>
            <dd>{session.settlement.payoffLongWad}</dd>
            <dt>Stale reference</dt>
            <dd>{String(session.settlement.staleReference)}</dd>
          </dl>
        </section>
      ) : null}
      {session.resolution !== undefined ? (
        <section aria-label="Resolution">
          <h3>Resolution</h3>
          <dl>
            <dt>Branch</dt>
            <dd>{session.resolution.branch}</dd>
            <dt>Gap</dt>
            <dd>{session.resolution.gapWad}</dd>
            <dt>Payoff</dt>
            <dd>{session.resolution.payoffWad}</dd>
            <dt>Settled</dt>
            <dd>{String(session.resolution.settled)}</dd>
          </dl>
        </section>
      ) : null}
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
      <SessionIntents quote={quote} />
      <SessionSettlementIntents settled={session.settled} />
    </div>
  );
}
