/**
 * Ports. Declarations only — no implementations.
 *
 * `QuoteSource` is the seam between the honest-quote use case and however quotes are loaded
 * (a JSON fixture or an RPC `eth_call`). `ChallengeSource` is the same seam for a labelled
 * challenge report: the application asks the port and never reaches a file or settlement adapter.
 */

import { type ChallengeReportView } from './challenge.js';
import { type IvProvenance } from './iv.js';
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
  /** The quote for `(nameId, forSession)`, or `Refuse` when the key is absent. */
  quote(nameId: string, forSession: bigint): Promise<Quote>;
}

/** One volatility reading before publish-time freshness selection. */
export interface IvReadingFields {
  readonly sigmaWad: bigint;
  readonly session: bigint;
  readonly provenance: IvProvenance;
}

/** Inputs for publishing BELL-IV for one session view. */
export interface IvPublishInput {
  readonly forSessionAddress: string;
  readonly viewSession: bigint;
  readonly boundSessions?: bigint;
  readonly pool: IvReadingFields;
  readonly fallback: IvReadingFields | null;
}

/** A source of BELL-IV publish inputs (fixture today, indexer later). */
export interface IvSource {
  /** Every publish input the source currently holds, in source order. */
  readings(): Promise<readonly IvPublishInput[]>;
}

/** A source of labelled challenge reports (fixture store today, live store later). */
export interface ChallengeSource {
  /** Every case label the source currently holds, in the order the source records them. */
  labels(): Promise<readonly string[]>;
  /** The adjudication report for `label`. */
  verify(label: string): Promise<ChallengeReportView>;
}
