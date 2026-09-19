/**
 * Compose a committed-input store from the process environment.
 *
 * Mirrors the web's `BELL_RPC_URL` opt-in: unset is the file fixture; set is HTTP. An explicit
 * file path (CLI `--store`) forces the file even when the URL is set. Construction of the HTTP
 * adapter does not call the network.
 */

import { type Keccak } from '@bell/calibrator/domain/ports.js';

import { type CommittedInputStore } from '../domain/ports.js';
import { loadCommittedInputStore } from './committed_input_store_file.js';
import { type FetchLike, HttpCommittedInputStore } from './committed_input_store_http.js';

export interface ResolveCommittedInputStoreInput {
  readonly keccak: Keccak;
  /** Default file path when HTTP is not selected. */
  readonly filePath: string;
  /**
   * When true, always load `filePath` and ignore `BELL_INPUT_STORE_URL`.
   * CLI `--store` sets this.
   */
  readonly forceFile?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: FetchLike;
}

/** Resolve file vs HTTP store. */
export async function resolveCommittedInputStore(
  input: ResolveCommittedInputStoreInput,
): Promise<CommittedInputStore> {
  if (input.forceFile === true) {
    return loadCommittedInputStore(input.filePath, input.keccak);
  }
  const baseUrl = envValue(input.env ?? {}, 'BELL_INPUT_STORE_URL');
  if (baseUrl !== undefined) {
    return new HttpCommittedInputStore({
      baseUrl,
      keccak: input.keccak,
      fetch: input.fetch ?? globalThis.fetch.bind(globalThis),
    });
  }
  return loadCommittedInputStore(input.filePath, input.keccak);
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
