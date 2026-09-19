/**
 * The HTTP-backed committed-input store.
 *
 * Fetch is mocked: a 200 returns a window, a 404 is undefined, other failures are typed adapter
 * errors. Construction does not call the network.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bytesFromHex } from '@bell/calibrator/domain/bytes.js';
import { describe, expect, it } from 'vitest';

import {
  CommittedInputStoreMalformed,
  CommittedInputStoreUnavailable,
} from '../../src/adapters/committed_input_store_file.js';
import {
  type FetchLike,
  HttpCommittedInputStore,
} from '../../src/adapters/committed_input_store_http.js';
import { nobleKeccak } from '../../src/adapters/keccak_noble.js';

const STORE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/committed_inputs.json', import.meta.url),
);
const CHALLENGE_PATH = fileURLToPath(
  new URL('../../../spec/fixtures/challenge.json', import.meta.url),
);

function upheldInputsHashHex(): string {
  const document = JSON.parse(readFileSync(CHALLENGE_PATH, 'utf8')) as {
    cases: readonly { label: string; inputsHash: string }[];
  };
  const upheld = document.cases.find((entry) => entry.label === 'upheld-store');
  if (upheld === undefined) throw new Error('fixture has no upheld-store case');
  return upheld.inputsHash;
}

function upheldWindowJson(): string {
  const document = JSON.parse(readFileSync(STORE_PATH, 'utf8')) as {
    windows: Record<string, unknown>;
  };
  const window = document.windows[upheldInputsHashHex()];
  if (window === undefined) throw new Error('store fixture missing upheld window');
  return JSON.stringify(window);
}

function mockFetch(handler: (url: string) => Promise<Response>): FetchLike {
  return async (input) => handler(input);
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpCommittedInputStore', () => {
  it('returns a window on HTTP 200', async () => {
    const hashHex = upheldInputsHashHex();
    const body = upheldWindowJson();
    const store = new HttpCommittedInputStore({
      baseUrl: 'https://store.example/inputs/',
      keccak: nobleKeccak,
      fetch: mockFetch(async (url) => {
        expect(url).toBe(`https://store.example/inputs/${hashHex}`);
        return jsonResponse(200, body);
      }),
    });
    const window = await store.window(bytesFromHex(hashHex));
    expect(window?.symbol).toBe('NVDA');
    expect(window?.bars).toHaveLength(100);
  });

  it('returns undefined on HTTP 404', async () => {
    const store = new HttpCommittedInputStore({
      baseUrl: 'https://store.example/inputs',
      keccak: nobleKeccak,
      fetch: mockFetch(async () => jsonResponse(404, 'missing')),
    });
    await expect(store.window(bytesFromHex(upheldInputsHashHex()))).resolves.toBeUndefined();
  });

  it('refuses a non-OK status other than 404 as unavailable', async () => {
    const store = new HttpCommittedInputStore({
      baseUrl: 'https://store.example/inputs',
      keccak: nobleKeccak,
      fetch: mockFetch(async () => jsonResponse(503, 'busy')),
    });
    await expect(store.window(bytesFromHex(upheldInputsHashHex()))).rejects.toBeInstanceOf(
      CommittedInputStoreUnavailable,
    );
  });

  it('refuses a network failure as unavailable', async () => {
    const store = new HttpCommittedInputStore({
      baseUrl: 'https://store.example/inputs',
      keccak: nobleKeccak,
      fetch: mockFetch(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    await expect(store.window(bytesFromHex(upheldInputsHashHex()))).rejects.toBeInstanceOf(
      CommittedInputStoreUnavailable,
    );
  });

  it('refuses a malformed body', async () => {
    const store = new HttpCommittedInputStore({
      baseUrl: 'https://store.example/inputs',
      keccak: nobleKeccak,
      fetch: mockFetch(async () => jsonResponse(200, '{"not":"a-window"}')),
    });
    await expect(store.window(bytesFromHex(upheldInputsHashHex()))).rejects.toBeInstanceOf(
      CommittedInputStoreMalformed,
    );
  });

  it('derives rowsDigest from the fetched window', async () => {
    const hashHex = upheldInputsHashHex();
    const store = new HttpCommittedInputStore({
      baseUrl: 'https://store.example/inputs',
      keccak: nobleKeccak,
      fetch: mockFetch(async () => jsonResponse(200, upheldWindowJson())),
    });
    const digest = await store.rowsDigest(bytesFromHex(hashHex));
    expect(digest).toBeInstanceOf(Uint8Array);
    expect(digest).toHaveLength(32);
  });

  it('refuses a blank base URL', () => {
    expect(
      () =>
        new HttpCommittedInputStore({
          baseUrl: '   ',
          keccak: nobleKeccak,
          fetch: mockFetch(async () => jsonResponse(404, '')),
        }),
    ).toThrow(CommittedInputStoreMalformed);
  });
});
