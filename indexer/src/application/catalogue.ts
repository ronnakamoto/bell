/**
 * The discovery use case.
 *
 * One function, two steps: ask the source for its logs, then fold them. Everything here is a use
 * case rather than domain — it sequences the domain's pieces and it touches nothing — so it is
 * callable with a list, which is the brief's test for whether something belongs in this layer.
 *
 * The source is a port. The fold is a pure function of a `RawLog` array and the three singleton
 * addresses. This module is the line between them, and it is the only asynchronous one: a network
 * read lives here, not in `domain/`.
 */

import { type Catalogue } from '../domain/catalogue.js';
import { foldLogs } from '../domain/fold.js';
import { type IndexerConfig, type LogSource } from '../domain/ports.js';

/** Fold the source's current logs into a catalogue, under the configured singleton addresses. */
export async function catalogueFrom(source: LogSource, config: IndexerConfig): Promise<Catalogue> {
  return foldLogs(await source.logs(), config);
}
