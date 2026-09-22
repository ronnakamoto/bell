import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { resolveSources } from '../../../adapters/corpus.js';
import { loadSession } from '../../../application/catalogue.js';
import { loadPublishedIv } from '../../../application/iv.js';
import { loadQuote } from '../../../application/quote.js';
import { BellIvPanel } from '../../../components/BellIvPanel.js';
import { EligibilityGate } from '../../../components/EligibilityGate.js';
import { QuotePanel } from '../../../components/QuotePanel.js';
import { SessionIntents } from '../../../components/SessionIntents.js';
import { SessionSettlementIntents } from '../../../components/SessionSettlementIntents.js';
import { type Quote } from '../../../domain/quote.js';

export default async function SessionPage({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<ReactNode> {
  const { logSource, quoteSource, ivSource, indexerConfig } = resolveSources();
  const { address } = await params;
  const session = await loadSession(logSource, indexerConfig, address);
  if (session === undefined) notFound();

  const linkedName = session.names[0];
  let quote: Quote;
  if (linkedName === undefined) {
    quote = { verdict: 'Refuse' };
  } else {
    quote = await loadQuote(quoteSource, linkedName.nameId, BigInt(linkedName.forSession));
  }
  const iv = await loadPublishedIv(ivSource, session.address);

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
            <dt>Long %</dt>
            <dd>{session.pool.health.longPct}%</dd>
            <dt>Short %</dt>
            <dd>{session.pool.health.shortPct}%</dd>
            <dt>Imbalance</dt>
            <dd>
              {session.pool.health.imbalance}%{session.pool.health.skewed ? ' ⚠️' : ''}
            </dd>
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
      <BellIvPanel iv={iv} />
      <EligibilityGate>
        <SessionIntents quote={quote} sessionAddress={session.address} />
        <SessionSettlementIntents settled={session.settled} sessionAddress={session.address} />
      </EligibilityGate>
    </div>
  );
}
