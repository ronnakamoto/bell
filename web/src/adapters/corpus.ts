/**
 * Producer corpus wiring for the web slice.
 *
 * Paths and singleton addresses are derived once from the committed fixture rather than repeated
 * in every use case. The three anchors match `spec/fixtures/logs.json` and the fold suite.
 */

import { fileURLToPath } from 'node:url';

import { type IndexerConfig } from '@bell/indexer/domain/ports.js';

/** Path to the producer log corpus, resolved from the repo root. */
export const LOGS_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/logs.json', import.meta.url),
);

/** The three singleton addresses the fold attributes against. */
export const INDEXER_CONFIG: IndexerConfig = {
  factory: '0xc7183455a4C133Ae270771860664b6B7ec320bB1',
  registry: '0xF62849F9A0B5Bf2913b396098F7c7019b51A820a',
  premium: '0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9',
};

/** The settled session address the corpus folds to (lower-case). */
export const CORPUS_SESSION_ADDRESS = '0x3fc355a5bc036ea3f52849bba638d3e257a0e6cc';
