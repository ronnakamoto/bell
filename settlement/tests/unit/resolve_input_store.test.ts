/**
 * resolveCommittedInputStore: file by default; HTTP when BELL_INPUT_STORE_URL is set;
 * forceFile ignores the URL.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bytesFromHex } from '@bell/calibrator/domain/bytes.js';
import { describe, expect, it } from 'vitest';

import { FileCommittedInputStore } from '../../src/adapters/committed_input_store_file.js';
import { HttpCommittedInputStore } from '../../src/adapters/committed_input_store_http.js';
import { nobleKeccak } from '../../src/adapters/keccak_noble.js';
import { resolveCommittedInputStore } from '../../src/adapters/resolve_input_store.js';

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

describe('resolveCommittedInputStore', () => {
  it('loads the file when the URL is unset', async () => {
    const store = await resolveCommittedInputStore({
      keccak: nobleKeccak,
      filePath: STORE_PATH,
      env: {},
    });
    expect(store).toBeInstanceOf(FileCommittedInputStore);
    const window = await store.window(bytesFromHex(upheldInputsHashHex()));
    expect(window?.symbol).toBe('NVDA');
  });

  it('uses HTTP when BELL_INPUT_STORE_URL is set', async () => {
    const store = await resolveCommittedInputStore({
      keccak: nobleKeccak,
      filePath: STORE_PATH,
      env: { BELL_INPUT_STORE_URL: 'https://store.example/inputs' },
      fetch: async () => new Response('missing', { status: 404 }),
    });
    expect(store).toBeInstanceOf(HttpCommittedInputStore);
    await expect(store.window(bytesFromHex(upheldInputsHashHex()))).resolves.toBeUndefined();
  });

  it('forceFile ignores the URL', async () => {
    const store = await resolveCommittedInputStore({
      keccak: nobleKeccak,
      filePath: STORE_PATH,
      forceFile: true,
      env: { BELL_INPUT_STORE_URL: 'https://store.example/inputs' },
      fetch: async () => {
        throw new Error('must not fetch');
      },
    });
    expect(store).toBeInstanceOf(FileCommittedInputStore);
  });

  it('treats a blank URL as unset', async () => {
    const store = await resolveCommittedInputStore({
      keccak: nobleKeccak,
      filePath: STORE_PATH,
      env: { BELL_INPUT_STORE_URL: '  ' },
    });
    expect(store).toBeInstanceOf(FileCommittedInputStore);
  });
});
