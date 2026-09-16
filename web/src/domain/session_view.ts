/**
 * Serialisable session and name views for pages and tests.
 *
 * Every numeric field from the indexer catalogue is a decimal string at this boundary so JSON
 * serialisation and React props never touch `bigint`. Domain formatting lives here rather than in
 * application, because the rules (WAD vs plain integer) are view concerns.
 */

import {
  type Catalogue,
  type NameRecord,
  type SessionRecord,
} from '@bell/indexer/domain/catalogue.js';

const WAD = 10n ** 18n;

/** One row on the session list page. */
export interface SessionListItem {
  readonly address: string;
  readonly lam: string;
  readonly expiryTimestamp: string;
  readonly registered: boolean;
  readonly settled: boolean;
}

/** One name commitment linked to a session. */
export interface NameListItem {
  readonly nameId: string;
  readonly forSession: string;
  readonly lambda: string;
  readonly premium: string;
}

/** Session detail for the per-session page. */
export interface SessionDetail extends SessionListItem {
  readonly referenceToken: string;
  readonly notionalCap: string;
  readonly cap: string;
  readonly salt: string;
  readonly names: readonly NameListItem[];
}

/** The catalogue mapped to strings-only view models. */
export interface CatalogueView {
  readonly sessions: readonly SessionListItem[];
  readonly names: readonly NameListItem[];
}

function formatWad(wad: bigint): string {
  const negative = wad < 0n;
  const magnitude = negative ? -wad : wad;
  const whole = magnitude / WAD;
  const fraction = magnitude % WAD;
  if (fraction === 0n) return `${negative ? '-' : ''}${String(whole)}`;
  const padded = fraction.toString().padStart(18, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${String(whole)}.${padded}`;
}

function formatInteger(value: bigint): string {
  return value.toString();
}

function toSessionListItem(session: SessionRecord): SessionListItem {
  return {
    address: session.address,
    lam: formatWad(session.lamWad),
    expiryTimestamp: formatInteger(session.expiryTimestamp),
    registered: session.registered,
    settled: session.resolution?.settled ?? false,
  };
}

function toNameListItem(name: NameRecord): NameListItem {
  return {
    nameId: name.nameId,
    forSession: formatInteger(name.forSession),
    lambda: formatWad(name.lambdaWad),
    premium: formatWad(name.premiumWad),
  };
}

/** Map an indexer catalogue to serialisable list rows. */
export function toCatalogueView(catalogue: Catalogue): CatalogueView {
  return {
    sessions: catalogue.sessions.map(toSessionListItem),
    names: catalogue.names.map(toNameListItem),
  };
}

/** Map one session and its linked names to a detail view. */
export function toSessionDetail(
  session: SessionRecord,
  names: readonly NameRecord[],
): SessionDetail {
  return {
    ...toSessionListItem(session),
    referenceToken: session.referenceToken,
    notionalCap: formatWad(session.notionalCapWad),
    cap: formatWad(session.capWad),
    salt: session.salt,
    names: names.map(toNameListItem),
  };
}
