/**
 * Producer corpus wiring for the web slice.
 *
 * Paths and singleton addresses are derived once from the committed fixture rather than repeated
 * in every use case. The three anchors match `spec/fixtures/logs.json` and the fold suite.
 *
 * `resolveSources` is the one place a page learns whether it is replaying that fixture or talking
 * to a node. `BELL_RPC_URL` unset is the replay; set, it is live logs and quotes against the three
 * env addresses. IV stays a file in both modes — this slice has no live IV publisher.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JsonRpcClient as IndexerRpcClient } from '@bell/indexer/adapters/json_rpc_client.js';
import { FileLogSource } from '@bell/indexer/adapters/log_source_file.js';
import { RpcLogSource } from '@bell/indexer/adapters/log_source_rpc.js';
import { type IndexerConfig, type LogSource } from '@bell/indexer/domain/ports.js';

import { type IvSource, type QuoteSource } from '../domain/ports.js';
import { FileIvSource } from './iv_source_file.js';
import { JsonRpcClient } from './json_rpc_client.js';
import { FileQuoteSource } from './quote_source_file.js';
import { RpcQuoteSource } from './quote_source_rpc.js';

const adapterDir = path.dirname(fileURLToPath(import.meta.url));

/** Path to the producer log corpus, resolved from the repo root. */
export const LOGS_PATH = path.resolve(adapterDir, '../../../spec/fixtures/logs.json');

/** Path to the committed quote fixture, resolved from the repo root. */
export const QUOTES_PATH = path.resolve(adapterDir, '../../../spec/fixtures/quotes.json');

/** Path to the committed BELL-IV fixture, resolved from the repo root. */
export const IV_PATH = path.resolve(adapterDir, '../../../spec/fixtures/iv.json');

/** The three singleton addresses the fold attributes against. */
export const INDEXER_CONFIG: IndexerConfig = {
  factory: '0xc7183455a4C133Ae270771860664b6B7ec320bB1',
  registry: '0xF62849F9A0B5Bf2913b396098F7c7019b51A820a',
  premium: '0x5991A2dF15A8F6A256D3Ec51E99254Cd3fb576A9',
};

/** The settled session address the corpus folds to (lower-case). */
export const CORPUS_SESSION_ADDRESS = '0x3fc355a5bc036ea3f52849bba638d3e257a0e6cc';

/** The adapters a page asks, plus the three singleton addresses the fold attributes against. */
export interface ResolvedSources {
  logSource: LogSource;
  quoteSource: QuoteSource;
  ivSource: IvSource;
  indexerConfig: IndexerConfig;
}

/**
 * Compose log, quote and IV sources from the process environment.
 *
 * No network happens here. RPC adapters hold a client and wait to be asked; a missing address is
 * a configuration error and is refused before a socket could open. `env` is an argument so a test
 * can stub it without mutating `process.env`.
 */
export function resolveSources(env: NodeJS.ProcessEnv = process.env): ResolvedSources {
  const rpcUrl = envValue(env, 'BELL_RPC_URL');
  if (rpcUrl === undefined) {
    return {
      logSource: new FileLogSource(LOGS_PATH),
      quoteSource: new FileQuoteSource(QUOTES_PATH),
      ivSource: new FileIvSource(IV_PATH),
      indexerConfig: INDEXER_CONFIG,
    };
  }

  const factory = requiredEnv(env, 'BELL_FACTORY');
  const registry = requiredEnv(env, 'BELL_REGISTRY');
  const premium = requiredEnv(env, 'BELL_PREMIUM');
  return {
    logSource: new RpcLogSource({
      client: new IndexerRpcClient({ url: rpcUrl }),
      addresses: [factory, registry, premium],
    }),
    quoteSource: new RpcQuoteSource({
      client: new JsonRpcClient({ url: rpcUrl }),
      premium,
    }),
    ivSource: new FileIvSource(IV_PATH),
    indexerConfig: { factory, registry, premium },
  };
}

/** A trimmed env value, or `undefined` when the var is unset or blank. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A required companion of `BELL_RPC_URL`; names the missing var when absent. */
function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = envValue(env, name);
  if (value === undefined) {
    throw new Error(`${name} is required when BELL_RPC_URL is set`);
  }
  return value;
}
