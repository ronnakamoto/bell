/**
 * Committed-input windows fetched over HTTP.
 *
 * Opt-in live store: `GET {baseUrl}/{inputsHash}` returns one window JSON (the same shape as a
 * single entry under `windows` in the file fixture). A 404 is ordinary unavailability
 * (`undefined`); other failures are typed adapter errors. Construction does not call the network.
 *
 * Fetch is injected so tests never open a socket.
 */

import { rowsDigest } from '@bell/calibrator/application/calibrate.js';
import { hexOf } from '@bell/calibrator/domain/bytes.js';
import { DailyBar, Wad } from '@bell/calibrator/domain/models.js';
import { type Keccak } from '@bell/calibrator/domain/ports.js';

import {
  type CommittedBar,
  type CommittedInputStore,
  type CommittedWindow,
} from '../domain/ports.js';
import {
  CommittedInputStoreMalformed,
  CommittedInputStoreUnavailable,
  parseCommittedWindowDocument,
} from './committed_input_store_file.js';

/** Minimal fetch surface the HTTP store needs. */
export type FetchLike = (input: string, init?: { readonly method?: string }) => Promise<Response>;

export interface HttpCommittedInputStoreFields {
  readonly baseUrl: string;
  readonly keccak: Keccak;
  readonly fetch: FetchLike;
}

/** HTTP-backed store. `rowsDigest` hashes the window's bars with the injected keccak. */
export class HttpCommittedInputStore implements CommittedInputStore {
  readonly #baseUrl: string;
  readonly #keccak: Keccak;
  readonly #fetch: FetchLike;

  constructor(fields: HttpCommittedInputStoreFields) {
    this.#baseUrl = normalizeBaseUrl(fields.baseUrl);
    this.#keccak = fields.keccak;
    this.#fetch = fields.fetch;
  }

  async window(inputsHash: Uint8Array): Promise<CommittedWindow | undefined> {
    const url = `${this.#baseUrl}/${keyOf(inputsHash)}`;
    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'GET' });
    } catch (error) {
      throw new CommittedInputStoreUnavailable(
        `could not fetch committed window at ${url}: ${describeError(error)}`,
      );
    }
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new CommittedInputStoreUnavailable(
        `committed window at ${url} returned HTTP ${String(response.status)}`,
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new CommittedInputStoreUnavailable(
        `could not read committed window at ${url}: ${describeError(error)}`,
      );
    }
    return parseCommittedWindowDocument(url, text);
  }

  async rowsDigest(inputsHash: Uint8Array): Promise<Uint8Array | undefined> {
    const held = await this.window(inputsHash);
    if (held === undefined) return undefined;
    return rowsDigest(this.#keccak, dailyBarsOf(held.bars));
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed === '') {
    throw new CommittedInputStoreMalformed('committed-input store base URL must not be blank');
  }
  return trimmed.replace(/\/+$/, '');
}

function keyOf(inputsHash: Uint8Array): string {
  return `0x${hexOf(inputsHash)}`;
}

function dailyBarsOf(bars: readonly CommittedBar[]): DailyBar[] {
  return bars.map(
    (bar) => new DailyBar(bar.tradingDate, new Wad(bar.closeWad), new Wad(bar.nextOpenWad)),
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
