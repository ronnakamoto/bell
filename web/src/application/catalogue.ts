/**
 * The catalogue use case.
 *
 * One function lists every session the producer corpus reveals; another loads one session's detail.
 * Both ask the indexer to fold the committed log fixture — the same acceptance the indexer's own
 * suite asserts — and map the result to string-only view models for pages.
 */

import { catalogueFrom } from '@bell/indexer/application/catalogue.js';
import { FileLogSource } from '@bell/indexer/adapters/log_source_file.js';
import { sessionOf } from '@bell/indexer/domain/catalogue.js';

import { INDEXER_CONFIG, LOGS_PATH } from '../adapters/corpus.js';
import {
  type CatalogueView,
  type SessionDetail,
  toCatalogueView,
  toSessionDetail,
} from '../domain/session_view.js';

async function foldCorpus() {
  return catalogueFrom(new FileLogSource(LOGS_PATH), INDEXER_CONFIG);
}

/** Load every session and name commitment from the producer corpus. */
export async function loadCatalogue(): Promise<CatalogueView> {
  return toCatalogueView(await foldCorpus());
}

/** Load one session by address, or `undefined` when the fold has never seen it. */
export async function loadSession(address: string): Promise<SessionDetail | undefined> {
  const catalogue = await foldCorpus();
  const session = sessionOf(catalogue, address);
  if (session === undefined) return undefined;
  const sessionIndex = catalogue.sessions.indexOf(session) + 1;
  const names = catalogue.names.filter((name) => name.forSession === BigInt(sessionIndex));
  return toSessionDetail(session, names);
}
