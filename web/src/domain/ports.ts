/**
 * Ports. Declarations only — no implementations.
 *
 * `QuoteSource` is the seam between the honest-quote use case and however quotes are loaded
 * (a JSON fixture today, an RPC `eth_call` later). The application asks the port; it never
 * reaches `node:fs` or a concrete adapter.
 */

import { type Quote } from './quote.js';

/** One fixture row keyed by `(nameId, forSession)`. */
export interface QuoteFixtureRow {
  readonly nameId: string;
  readonly forSession: bigint;
  readonly quote: Quote;
}

/** A source of committed oracle quotes. */
export interface QuoteSource {
  /** Every quote the source currently holds, in the order the source records them. */
  quotes(): Promise<readonly QuoteFixtureRow[]>;
}
