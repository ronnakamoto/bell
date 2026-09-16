/**
 * The session catalogue: every fact the fold recovers from logs, and nothing it infers.
 *
 * Discovery is a read problem. `SessionFactory.sessionDeployed` answers *"does this session exist"*
 * and not *"which sessions exist"*, so a catalogue built from the lifecycle's events is the missing
 * layer. Everything here is a field some event actually carried — a derived "is live" flag that
 * restated `resolution !== undefined && settlesSession(branch)` would be a second copy of a fact the
 * record already has, and a second copy is how F94's provenance note disagreed with its corpus.
 *
 * **Three collections, because the three kinds of record do not share a key.** A session is an
 * address learned from `SessionCreated`. A name commitment is `(nameId, forSession)` — the premium
 * store's key, which is not a session address and must not be read as one (the `nameId` topic is a
 * `bytes32`, and `addressOf` refuses it). A print is an insertion in the book, keyed by the index
 * the registry assigned. Folding any of them into another would invent a join the logs do not make.
 *
 * **`registered` is a field rather than a filter.** `createSession` deploys a session and never
 * calls `registerSession` (F93), so a created session is a first-class row that may still be
 * unsettleable. Dropping the unregistered ones would hide the liveness gap the listing path has.
 */

import { type Branch } from './branch.js';
import { addressKey, type AddressKey, type Word } from './log.js';

/** The identity `SessionCreated` carries, which is everything a client needs to find the session. */
export interface SessionIdentity {
  readonly address: AddressKey;
  readonly referenceToken: AddressKey;
  readonly lamWad: bigint;
  readonly expiryTimestamp: bigint;
  /** The lattice cap recorded at listing, in WAD. */
  readonly capWad: bigint;
  readonly notionalCapWad: bigint;
  readonly salt: Word;
}

/** The pool's reserves after a seed, as `PoolSeeded` reports them. */
export interface PoolSnapshot {
  readonly longIn: bigint;
  readonly shortIn: bigint;
  readonly longReserve: bigint;
  readonly shortReserve: bigint;
}

/** One shares mint, as `PoolSharesMinted` reports it. */
export interface SharesSnapshot {
  readonly provider: AddressKey;
  readonly shares: bigint;
  readonly longIn: bigint;
  readonly shortIn: bigint;
}

/** One trade, as `Traded` reports it. */
export interface TradeSnapshot {
  readonly trader: AddressKey;
  readonly boughtLong: boolean;
  readonly collateralIn: bigint;
  readonly claimOut: bigint;
}

/** The session's own settlement, as `Settled` reports it. Absent on `Deferred`. */
export interface SettlementSnapshot {
  readonly payoffLongWad: bigint;
  readonly staleReference: boolean;
}

/**
 * The registry's resolution.
 *
 * `settled` is `settlesSession(branch)` captured at fold time, so a reader does not have to know
 * that `Deferred` is the one branch that does not settle — and so a later change to that rule is
 * visible in the record rather than re-derived by every consumer.
 */
export interface ResolutionSnapshot {
  readonly branch: Branch;
  readonly gapWad: bigint;
  readonly payoffWad: bigint;
  readonly settled: boolean;
}

/** One session, as the fold has reconstructed it. */
export interface SessionRecord extends SessionIdentity {
  /** Whether `SessionRegistered` has been seen. False after `createSession` alone (F93). */
  readonly registered: boolean;
  /** The multiplier recorded at registration, against which G8 will judge. */
  readonly multiplier: bigint | undefined;
  readonly pool: PoolSnapshot | undefined;
  readonly shares: SharesSnapshot | undefined;
  readonly lastTrade: TradeSnapshot | undefined;
  readonly settlement: SettlementSnapshot | undefined;
  readonly resolution: ResolutionSnapshot | undefined;
}

/** One bonded commitment, as the premium store's three events reconstruct it. */
export interface NameRecord {
  readonly nameId: Word;
  readonly forSession: bigint;
  readonly lambdaWad: bigint;
  readonly premiumWad: bigint;
  readonly inputsHash: Word;
  readonly digest: Word;
  readonly bond: bigint;
  readonly challenger: AddressKey | undefined;
  readonly publisherCorrect: boolean | undefined;
  readonly transferred: bigint | undefined;
}

/** One accepted print, as `PrintSubmitted` reports it. */
export interface PrintRecord {
  readonly source: AddressKey;
  readonly priority: bigint;
  readonly timestamp: bigint;
  readonly gapWad: bigint;
  readonly index: bigint;
}

/**
 * Everything the fold recovered, in first-seen order.
 *
 * Arrays rather than maps, because a catalogue is enumerated — *"which sessions exist"* — and a
 * lookup is a scan of a list the discovery layer is expected to keep small. The helpers below are
 * the only way to ask by key, so a comparison that forgot to normalise the address cannot be written
 * as `catalogue.sessions.get(raw)`.
 */
export interface Catalogue {
  readonly sessions: readonly SessionRecord[];
  readonly names: readonly NameRecord[];
  readonly prints: readonly PrintRecord[];
}

const EMPTY: Catalogue = Object.freeze({
  sessions: Object.freeze([]),
  names: Object.freeze([]),
  prints: Object.freeze([]),
});

/** The empty catalogue. Frozen, so a caller cannot populate it by mutation instead of by folding. */
export function emptyCatalogue(): Catalogue {
  return EMPTY;
}

/** The session at `address`, or `undefined` if the fold has never seen a `SessionCreated` for it. */
export function sessionOf(catalogue: Catalogue, address: string): SessionRecord | undefined {
  const key = addressKey(address);
  return catalogue.sessions.find((session) => session.address === key);
}

/** The name commitment at `(nameId, forSession)`, or `undefined` if none has been committed. */
export function nameOf(
  catalogue: Catalogue,
  nameId: Word,
  forSession: bigint,
): NameRecord | undefined {
  return catalogue.names.find((name) => name.nameId === nameId && name.forSession === forSession);
}
