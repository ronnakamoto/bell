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

/** Case identity for an on-chain challenge: `nameId` is `0x` + 64 hex. */
export interface ChallengeCaseIdentity {
  readonly nameId: string;
  readonly forSession: bigint;
}

/** A source of labelled challenge reports (fixture store today, live store later). */
export interface ChallengeSource {
  /** Every case label the source currently holds, in the order the source records them. */
  labels(): Promise<readonly string[]>;
  /** The adjudication report for `label`. */
  verify(label: string): Promise<ChallengeReportView>;
  /** The `(nameId, forSession)` of the case labelled `label`. */
  identity(label: string): Promise<ChallengeCaseIdentity>;
}

/** One transaction to broadcast. */
export interface WalletTx {
  /** The contract to call. */
  readonly to: string;
  /** The calldata, as `0x`-prefixed hex. */
  readonly data: string;
}

/**
 * The seam between the broadcast use case and whatever wallet is injected.
 *
 * `connect` returns the account the wallet will sign with; `read` is an `eth_call` returning the
 * raw 32-byte result word (the use case decodes it); `send` broadcasts a transaction and returns
 * its hash. The use case never learns whether the provider is `window.ethereum`, a test double or
 * a future wallet SDK.
 */
export interface WalletProvider {
  /** The account the wallet will sign with, connecting first if needed. */
  connect(): Promise<string>;
  /** The raw result word of `eth_call` to `address` with `calldata`. */
  read(address: string, calldata: string): Promise<string>;
  /** Broadcast `tx` and return its hash. */
  send(tx: WalletTx): Promise<string>;
}
